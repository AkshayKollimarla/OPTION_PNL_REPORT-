/**
 * Watches the open strategies and sends a Telegram message when a coin comes
 * within the set distance of one of its limits.
 *
 * Runs on the server, not in the page: an alert has to arrive whether or not
 * anyone has the dashboard open, which is the whole point of it going to a
 * phone.
 */

import optionsPool from "./options-db.js";
import { deriveLimits, triggersFor, evaluate, alertMessage, DEFAULT_OFFSET } from "./price-alerts.js";
import { hyperliquidMids, priceFor } from "./price-feed.js";
import { ensureAlertTable, loadSettings, saveArmedState } from "./price-alert-store.js";

// Every 30 seconds. The alert is a dollar-wide warning, not an execution
// signal, and a tighter loop would hammer three venues to no purpose.
const POLL_MS = 30_000;

// Survives dev-mode hot reload, which would otherwise leave a second timer
// running and send every alert twice.
const _state = globalThis.__priceAlertWorker || (globalThis.__priceAlertWorker = { timer: null, running: false });

async function send(text) {
  // A dedicated bot if one is configured, otherwise the one the auto-close
  // worker already uses -- so alerts work out of the box and can be split
  // onto their own bot by setting two variables.
  const token = process.env.PRICE_ALERT_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.PRICE_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, error: "no telegram bot configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const json = await res.json();
    return json.ok ? { ok: true } : { ok: false, error: json.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function tick() {
  await ensureAlertTable();

  const [legs] = await optionsPool.query(`
    SELECT t.id, t.group_id, t.token, t.option_type, t.opt_entry_qty, t.options_strike,
           t.fut_entry_price, t.upside_distance, t.down_distance,
           DATE_FORMAT(t.expiry, '%Y-%m-%d') AS expiry,
           a.name AS account, a.api_key, a.api_secret
      FROM options_trades t
      LEFT JOIN trading_accounts a ON a.id = t.account_id
     WHERE t.status = 'open'
     ORDER BY t.token, t.group_id, COALESCE(t.leg_index, t.id)`);
  if (!legs.length) return { checked: 0, sent: 0 };

  const groups = new Map();
  for (const l of legs) {
    const key = l.group_id ? `g:${l.group_id}` : `s:${l.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }

  const settings = await loadSettings();
  const mids = await hyperliquidMids();
  let sent = 0;

  for (const [key, group] of groups) {
    const saved = settings.get(key) || {};
    if (saved.enabled === false) continue;

    const first = group[0];
    const limits = deriveLimits(group);
    const triggers = triggersFor(limits, {
      offset: saved.offset_usd ?? DEFAULT_OFFSET,
      alertUpper: saved.alert_upper,
      alertLower: saved.alert_lower,
    });

    const { price } = await priceFor({
      token: first.token,
      credential: first.api_key ? { api_key: first.api_key, api_secret: first.api_secret } : null,
      mids,
    });

    const { fire, state } = evaluate({
      price,
      triggers,
      limits,
      state: { upperArmed: saved.upperArmed, lowerArmed: saved.lowerArmed },
    });

    for (const f of fire) {
      const res = await send(alertMessage({
        token: first.token,
        account: first.account,
        side: f.side,
        price,
        trigger: f.trigger,
        limit: f.side === "upper" ? limits.upper : limits.lower,
        expiry: first.expiry,
      }));
      if (res.ok) sent += 1;
      else console.warn(`[price-alerts] ${key} ${f.side}: ${res.error}`);
    }

    // Written every pass, not only when something fires: re-arming on the way
    // out of a zone is what lets the next approach be reported.
    await saveArmedState(key, state, fire.length > 0);
  }

  return { checked: groups.size, sent };
}

export function startWorker() {
  if (_state.timer) return;
  _state.timer = setInterval(async () => {
    if (_state.running) return;        // a slow pass must not overlap the next
    _state.running = true;
    try {
      await tick();
    } catch (e) {
      console.error("[price-alerts] tick failed:", e.message);
    } finally {
      _state.running = false;
    }
  }, POLL_MS);
  console.log(`[price-alerts] watching open strategies every ${POLL_MS / 1000}s`);
}

/**
 * Watches the open strategies and sends a Telegram message when a coin comes
 * within the set distance of one of its limits.
 *
 * Runs on the server, not in the page: an alert has to arrive whether or not
 * anyone has the dashboard open, which is the whole point of it going to a
 * phone.
 */

import { evaluate, alertMessage } from "./price-alerts.js";
import { buildRows } from "./price-alert-rows.js";
import { ensureAlertTable, saveArmedState } from "./price-alert-store.js";

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

  // The same list the page shows, built by the same code: what is watched and
  // where its alerts sit cannot drift between the two.
  const { rows } = await buildRows();
  if (!rows.length) return { checked: 0, sent: 0 };

  let sent = 0;
  for (const row of rows) {
    if (row.enabled === false) continue;

    const { fire, state } = evaluate({
      price: row.price,
      triggers: row.triggers,
      limits: row.limits,
      state: { upperArmed: row.upperArmed, lowerArmed: row.lowerArmed },
    });

    for (const f of fire) {
      const res = await send(alertMessage({
        token: row.token,
        account: row.account,
        side: f.side,
        price: row.price,
        trigger: f.trigger,
        limit: f.side === "upper" ? row.upper : row.lower,
        expiry: row.expiry,
      }));
      if (res.ok) sent += 1;
      else console.warn(`[price-alerts] ${row.key} ${f.side}: ${res.error}`);
    }

    // Written every pass, not only when something fires: re-arming on the way
    // out of a zone is what lets the next approach be reported.
    await saveArmedState(row.key, state, fire.length > 0);
  }

  return { checked: rows.length, sent };
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

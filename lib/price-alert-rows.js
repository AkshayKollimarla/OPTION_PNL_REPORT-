// Builds the watch list the page and the worker both work from, so the two
// can never disagree about what is being watched or where its alerts sit.
//
// Two kinds of row share one shape:
//
//   strategy  one per OPEN options structure. Its band is read off the short
//             strikes, and it appears and disappears with the strategy.
//   manual    added by hand for any symbol. Its levels ARE its band; it
//             stands on its own and outlives whatever the book is doing.

import optionsPool from "./options-db.js";
import { deriveLimits, triggersFor, priceLooksRelated, DEFAULT_OFFSET } from "./price-alerts.js";
import { hyperliquidMids, priceFor, coinOf } from "./price-feed.js";
import { loadSettings, loadManual } from "./price-alert-store.js";

const LEG_SQL = `
  SELECT t.id, t.group_id, t.token, t.option_type, t.opt_entry_qty, t.options_strike,
         t.fut_entry_price, t.upside_distance, t.down_distance,
         DATE_FORMAT(t.expiry, '%Y-%m-%d')     AS expiry,
         DATE_FORMAT(t.entry_date, '%Y-%m-%d') AS entry_date,
         a.name AS account, a.api_key, a.api_secret
    FROM options_trades t
    LEFT JOIN trading_accounts a ON a.id = t.account_id
   WHERE t.status = 'open'
   ORDER BY t.token, t.group_id, COALESCE(t.leg_index, t.id)`;

/**
 * Any Alpaca credential on the book.
 *
 * A manual alert names a symbol, not an account, so when the symbol turns out
 * to be a US equity there has to be a key to ask with. Any Alpaca key reads
 * the same public quote, so the first one serves.
 */
async function alpacaCredential() {
  const [rows] = await optionsPool.query(
    `SELECT api_key, api_secret FROM trading_accounts
      WHERE api_key LIKE 'PK%' OR api_key LIKE 'AK%' LIMIT 1`);
  return rows.length ? { api_key: rows[0].api_key, api_secret: rows[0].api_secret } : null;
}

export async function buildRows() {
  const [legs] = await optionsPool.query(LEG_SQL);

  const groups = new Map();
  for (const l of legs) {
    const key = l.group_id ? `g:${l.group_id}` : `s:${l.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }

  const settings = await loadSettings();
  const manual = await loadManual();
  const mids = await hyperliquidMids();
  const fallbackCred = manual.length ? await alpacaCredential() : null;

  const rows = [];

  for (const [key, group] of groups) {
    const first = group[0];
    const saved = settings.get(key) || {};
    rows.push(await assemble({
      key,
      kind: "strategy",
      token: first.token,
      account: first.account,
      legs: group.length,
      entry_date: first.entry_date,
      expiry: first.expiry,
      limits: deriveLimits(group),
      saved,
      credential: first.api_key ? { api_key: first.api_key, api_secret: first.api_secret } : fallbackCred,
      mids,
    }));
  }

  for (const m of manual) {
    rows.push(await assemble({
      key: m.key,
      kind: "manual",
      token: m.token,
      account: null,
      legs: 0,
      // A manual alert's levels are its band, and they came from the person
      // who typed them, so no strike or distance is involved.
      limits: { upper: m.alert_upper, lower: m.alert_lower, upperFrom: "you", lowerFrom: "you", futPrice: null },
      saved: { ...m, alert_upper: null, alert_lower: null },
      credential: fallbackCred,
      mids,
    }));
  }

  rows.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === "strategy" ? -1 : 1) ||
    a.coin.localeCompare(b.coin) ||
    String(a.entry_date || "").localeCompare(String(b.entry_date || "")));
  return { rows, telegram: settings.telegram };
}

async function assemble({ key, kind, token, account, legs, entry_date, expiry, limits, saved, credential, mids }) {
  const triggers = triggersFor(limits, {
    offset: saved.offset_usd ?? DEFAULT_OFFSET,
    alertUpper: saved.alert_upper,
    alertLower: saved.alert_lower,
  });
  const { price, source, error, delayedMinutes } = await priceFor({ token, credential, mids });

  return {
    key, kind, token, account,
    coin: coinOf(token),
    legs,
    entry_date: entry_date || null,
    expiry: expiry || null,
    upper: limits.upper,
    lower: limits.lower,
    upperFrom: limits.upperFrom,
    lowerFrom: limits.lowerFrom,
    upperTrigger: triggers.upper,
    lowerTrigger: triggers.lower,
    upperManual: triggers.upperManual,
    lowerManual: triggers.lowerManual,
    offset: triggers.offset,
    enabled: saved.enabled === undefined ? true : !!saved.enabled,
    upperArmed: saved.upperArmed,
    lowerArmed: saved.lowerArmed,
    price,
    priceSource: source,
    priceError: error || null,
    delayedMinutes: delayedMinutes ?? null,
    priceMismatch: price != null && !priceLooksRelated(price, limits),
    lastFiredAt: saved.last_fired_at || null,
    limits,
    triggers,
  };
}

/** Price one symbol on its own, for the add form to check before saving. */
export async function quoteSymbol(token) {
  const mids = await hyperliquidMids();
  const cred = await alpacaCredential();
  return priceFor({ token, credential: cred, mids });
}

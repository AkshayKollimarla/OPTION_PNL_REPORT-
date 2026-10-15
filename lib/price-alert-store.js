// Where a price alert's SETTINGS live.
//
// Only the overrides are stored. The watch list itself is read from the open
// strategies every time, so opening or closing one on the Options Dashboard
// adds or removes a row here with nothing to keep in step by hand -- and a
// strategy that is closed and reopened finds its settings waiting.
//
// Kept in the options database beside the strategies these rows key off,
// rather than in the bot database: a row here is meaningless without the
// strategy it belongs to.

import pool from "./options-db.js";

const TABLE = "price_alert_settings";

// Same pattern as the auto-close worker: cached so every request can await
// it, and re-run when this file changes so a new column reaches a running
// server rather than waiting for someone to notice.
const _state = globalThis.__priceAlertStore || (globalThis.__priceAlertStore = { ensured: null, fn: null });

async function _create() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      -- "g:<group_id>" for a combined strategy, "s:<id>" for a single leg.
      strategy_key    VARCHAR(120) NOT NULL,
      offset_usd      DECIMAL(14,4) NULL,
      alert_upper     DECIMAL(18,6) NULL,
      alert_lower     DECIMAL(18,6) NULL,
      enabled         TINYINT(1) NOT NULL DEFAULT 1,
      -- Hysteresis: an alert fires on entering its zone and re-arms on
      -- leaving, so a price sitting at the limit does not alert every poll.
      upper_armed     TINYINT(1) NOT NULL DEFAULT 1,
      lower_armed     TINYINT(1) NOT NULL DEFAULT 1,
      -- A manual alert is not tied to a strategy: it names its own symbol and
      -- its own levels, and survives whatever the options book is doing.
      kind            VARCHAR(12) NOT NULL DEFAULT 'strategy',
      token           VARCHAR(60) NULL,
      last_fired_at   DATETIME NULL,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_strategy (strategy_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Columns added after the table first shipped. ALTER is attempted and its
// failure ignored, which is how the rest of this codebase migrates: there is
// no "column exists" test that is not itself a race.
async function _addColumns() {
  for (const [col, def] of [
    ["kind",  "VARCHAR(12) NOT NULL DEFAULT 'strategy'"],
    ["token", "VARCHAR(60) NULL"],
  ]) {
    try { await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN ${col} ${def}`); }
    catch { /* already there */ }
  }
}

export function ensureAlertTable() {
  if (_state.ensured && _state.fn === _create) return _state.ensured;
  _state.fn = _create;
  _state.ensured = _create().then(_addColumns).catch((e) => {
    _state.ensured = null;             // let the next caller retry
    throw e;
  });
  return _state.ensured;
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Every saved setting, keyed by strategy. */
export async function loadSettings() {
  const [rows] = await pool.query(`SELECT * FROM ${TABLE}`);
  const map = new Map();
  for (const r of rows) {
    map.set(r.strategy_key, {
      kind: r.kind || "strategy",
      token: r.token || null,
      offset_usd: num(r.offset_usd),
      alert_upper: num(r.alert_upper),
      alert_lower: num(r.alert_lower),
      enabled: !!r.enabled,
      upperArmed: !!r.upper_armed,
      lowerArmed: !!r.lower_armed,
      last_fired_at: r.last_fired_at,
    });
  }
  // Where the alerts are sent. Read from the environment rather than stored,
  // so a bot token never sits in the database or reaches the browser.
  map.telegram = {
    configured: Boolean(
      (process.env.PRICE_ALERT_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN) &&
      (process.env.PRICE_ALERT_CHAT_ID || process.env.TELEGRAM_CHAT_ID)
    ),
    dedicated: Boolean(process.env.PRICE_ALERT_BOT_TOKEN && process.env.PRICE_ALERT_CHAT_ID),
  };
  return map;
}

/**
 * Save one strategy's settings.
 *
 * A changed threshold re-arms that side: the new level has not been alerted
 * on yet, and leaving it disarmed would swallow the first crossing of it.
 */
export async function saveSettings({ key, offset_usd, alert_upper, alert_lower, enabled }) {
  if (!key) throw new Error("A strategy key is required.");
  await pool.query(
    `INSERT INTO ${TABLE} (strategy_key, offset_usd, alert_upper, alert_lower, enabled, upper_armed, lower_armed)
     VALUES (?, ?, ?, ?, ?, 1, 1)
     ON DUPLICATE KEY UPDATE
       offset_usd = VALUES(offset_usd),
       alert_upper = VALUES(alert_upper),
       alert_lower = VALUES(alert_lower),
       enabled = VALUES(enabled),
       upper_armed = 1,
       lower_armed = 1`,
    [key, num(offset_usd), num(alert_upper), num(alert_lower), enabled === false ? 0 : 1]
  );
}

/** Record what the worker decided, so the next poll knows what has fired. */
export async function saveArmedState(key, { upperArmed, lowerArmed }, fired) {
  await pool.query(
    `INSERT INTO ${TABLE} (strategy_key, upper_armed, lower_armed, last_fired_at)
     VALUES (?, ?, ?, ${fired ? "NOW()" : "NULL"})
     ON DUPLICATE KEY UPDATE
       upper_armed = VALUES(upper_armed),
       lower_armed = VALUES(lower_armed)
       ${fired ? ", last_fired_at = NOW()" : ""}`,
    [key, upperArmed ? 1 : 0, lowerArmed ? 1 : 0]
  );
}

/** Every manually added alert, which stands on its own rather than on a strategy. */
export async function loadManual() {
  const [rows] = await pool.query(`SELECT * FROM ${TABLE} WHERE kind = 'manual' ORDER BY token, id`);
  return rows.map((r) => ({
    key: r.strategy_key,
    token: r.token,
    offset_usd: num(r.offset_usd),
    alert_upper: num(r.alert_upper),
    alert_lower: num(r.alert_lower),
    enabled: !!r.enabled,
    upperArmed: !!r.upper_armed,
    lowerArmed: !!r.lower_armed,
    last_fired_at: r.last_fired_at,
  }));
}

/**
 * Add an alert for any symbol, strategy or no strategy.
 *
 * The levels ARE the limits here -- there is no structure to read them off --
 * so the same offset rule applies: the alert lands that far inside each one,
 * and an offset of zero alerts exactly at the level.
 */
export async function addManual({ token, upper, lower, offset_usd }) {
  const sym = String(token || "").trim().toUpperCase();
  if (!sym) throw new Error("A symbol is required.");
  if (num(upper) === null && num(lower) === null) {
    throw new Error("Set an upper level, a lower level, or both.");
  }
  const key = `m:${sym}:${Date.now()}`;
  await pool.query(
    `INSERT INTO ${TABLE} (strategy_key, kind, token, offset_usd, alert_upper, alert_lower, enabled, upper_armed, lower_armed)
     VALUES (?, 'manual', ?, ?, ?, ?, 1, 1, 1)`,
    [key, sym, num(offset_usd), num(upper), num(lower)]
  );
  return key;
}

/** Remove one. Only a manual alert can be deleted -- a strategy's row belongs to the strategy. */
export async function removeManual(key) {
  const [res] = await pool.query(`DELETE FROM ${TABLE} WHERE strategy_key = ? AND kind = 'manual'`, [key]);
  if (!res.affectedRows) throw new Error("No manual alert with that key.");
}

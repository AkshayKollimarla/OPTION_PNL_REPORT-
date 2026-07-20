/**
 * Server-side auto-close worker for MULTI-LEG combo strategies (Combined
 * Simulator). Same design as lib/auto-close-worker.js (single-leg), extended
 * to N option+futures leg pairs: freezes combined ETH/BTC+USDC equity at
 * entry, closes ALL legs (maker-chase options, market futures) once that
 * combined total rises by the target $, same as the single-leg design.
 */

import pool from "./options-db.js";
import { sendTelegramAlert } from "./telegram.js";
import {
  auth, collateral, positionFlat, isOptionExpired, placeLimitClose, placeMarketClose, rpc,
} from "./deribit-close-helpers.js";

const POLL_MS             = 5_000;
const APPROACH_THRESHOLD  = 0.9;
const OPT_REQUOTE_THRESHOLD = 0.00005;
const ERROR_THRESHOLD     = 12;          // ~1 min of continuous failures before giving up — survives a brief network blip, doesn't mask a genuinely broken job for long

// Survive Next.js dev-mode hot-reload — see lib/auto-close-worker.js for why
// both the running flag AND a function-identity check are needed.
const _state = globalThis.__autoCloseComboWorkerState || (globalThis.__autoCloseComboWorkerState = {
  timer: null, running: false, tableEnsuredPromise: null, tickFn: null, createTableFn: null,
});

// ─── Public API ──────────────────────────────────────────────────────────────

export function ensureComboTables() {
  if (_state.tableEnsuredPromise && _state.createTableFn === _createTables) {
    return _state.tableEnsuredPromise;
  }
  _state.createTableFn = _createTables;
  _state.tableEnsuredPromise = _createTables().catch(err => {
    _state.tableEnsuredPromise = null;
    throw err;
  });
  return _state.tableEnsuredPromise;
}

export function startComboWorker() {
  if (_state.running && _state.tickFn === _tick) return;
  if (_state.timer) clearInterval(_state.timer);
  _state.running = true;
  _state.tickFn  = _tick;
  ensureComboTables()
    .then(() => {
      console.log("[auto-close-combo-worker] started (fresh tick loop)");
      _tick();
      _state.timer = setInterval(_tick, POLL_MS);
    })
    .catch(e => {
      console.error("[auto-close-combo-worker] table init failed:", e.message);
      _state.running = false;
    });
}

export function stopComboWorker() {
  clearInterval(_state.timer); _state.timer = null; _state.running = false;
  console.log("[auto-close-combo-worker] stopped");
}

// ─── DB bootstrap ────────────────────────────────────────────────────────────

async function _createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_close_combo_jobs (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      group_id            VARCHAR(100) NULL,
      account_id          INT NOT NULL,
      token               VARCHAR(50) NOT NULL,
      initial_total_usd   DECIMAL(14,4) NOT NULL,
      final_equity_usd    DECIMAL(14,4) NULL,
      target_pnl          DECIMAL(12,4) NOT NULL,
      target_total_usd    DECIMAL(14,4) NOT NULL,
      status              ENUM('active','closing','completed','failed','stopped') NOT NULL DEFAULT 'active',
      approach_alert_sent TINYINT(1) NOT NULL DEFAULT 0,
      triggered_at        DATETIME NULL,
      completed_at        DATETIME NULL,
      last_checked_at     DATETIME NULL,
      last_equity_usd     DECIMAL(14,4) NULL,
      log_json            LONGTEXT NULL,
      error_msg           TEXT NULL,
      consecutive_errors  INT NOT NULL DEFAULT 0,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Migrate columns for a table created before this feature existed
  for (const [col, def] of [
    ["consecutive_errors", "INT NOT NULL DEFAULT 0"],
  ]) {
    try { await pool.query(`ALTER TABLE auto_close_combo_jobs ADD COLUMN ${col} ${def}`); }
    catch { /* column already exists */ }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_close_combo_legs (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      combo_job_id     INT NOT NULL,
      leg_index        INT NOT NULL,
      leg_type         VARCHAR(20) NULL,
      opt_instrument   VARCHAR(100) NOT NULL DEFAULT '',
      opt_qty          DECIMAL(12,6) NOT NULL DEFAULT 0,
      opt_dir          ENUM('buy','sell') NOT NULL DEFAULT 'sell',
      opt_entry_price  DECIMAL(18,8) NULL,
      opt_close_price  DECIMAL(18,8) NULL,
      opt_order_id     VARCHAR(100) NULL,
      opt_done         TINYINT(1) NOT NULL DEFAULT 0,
      fut_instrument   VARCHAR(100) NOT NULL DEFAULT '',
      fut_qty          DECIMAL(12,6) NOT NULL DEFAULT 0,
      fut_dir          ENUM('buy','sell') NOT NULL DEFAULT 'sell',
      fut_entry_price  DECIMAL(18,4) NULL,
      fut_close_price  DECIMAL(18,4) NULL,
      fut_done         TINYINT(1) NOT NULL DEFAULT 0,
      FOREIGN KEY (combo_job_id) REFERENCES auto_close_combo_jobs(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function _log(comboJobId, msg) {
  const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(`[auto-close-combo-worker #${comboJobId}]`, msg);
  try {
    await pool.query(
      `UPDATE auto_close_combo_jobs
         SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?)
       WHERE id = ?`,
      [line, comboJobId]
    );
  } catch (e) {
    const [[row]] = await pool.query(`SELECT log_json FROM auto_close_combo_jobs WHERE id=?`, [comboJobId]);
    let arr = [];
    try { arr = JSON.parse(row?.log_json || "[]"); } catch {}
    arr.push(line);
    await pool.query(`UPDATE auto_close_combo_jobs SET log_json=? WHERE id=?`, [JSON.stringify(arr), comboJobId]);
  }
}

async function _setStatus(comboJobId, status, extras = {}) {
  const parts = ["status=?"];
  const vals  = [status];
  if (extras.triggered) { parts.push("triggered_at=NOW()"); }
  if (extras.completed) { parts.push("completed_at=NOW()"); }
  if (extras.error_msg) { parts.push("error_msg=?"); vals.push(extras.error_msg); }
  vals.push(comboJobId);
  await pool.query(`UPDATE auto_close_combo_jobs SET ${parts.join(", ")} WHERE id=?`, vals);
}

// ─── Main poll tick ───────────────────────────────────────────────────────────

async function _tick() {
  let jobs;
  try {
    [jobs] = await pool.query(
      `SELECT * FROM auto_close_combo_jobs WHERE status IN ('active','closing')`
    );
  } catch (e) {
    console.error("[auto-close-combo-worker] DB query failed:", e.message);
    return;
  }

  for (const job of jobs) {
    try {
      await _processComboJob(job);
      if (job.consecutive_errors) {
        try { await pool.query(`UPDATE auto_close_combo_jobs SET consecutive_errors=0 WHERE id=?`, [job.id]); } catch {}
      }
    } catch (err) {
      const nextCount = (job.consecutive_errors || 0) + 1;
      if (err.isExchangeOutage) {
        // Deribit itself is down (maintenance/5xx), not a job-specific
        // problem — keep retrying indefinitely instead of counting toward
        // ERROR_THRESHOLD, and only write to the persisted log ~once a
        // minute so a long outage doesn't flood log_json with a line every 5s.
        console.error(`[auto-close-combo-worker #${job.id}] Deribit appears to be down (attempt ${nextCount}), not counted toward the failure limit:`, err.message);
        try { await pool.query(`UPDATE auto_close_combo_jobs SET consecutive_errors=? WHERE id=?`, [nextCount, job.id]); } catch {}
        if (nextCount % 12 === 1) {
          try { await _log(job.id, `Deribit appears to be under maintenance/unreachable — still retrying (${nextCount} attempts so far), job stays active.`); } catch {}
        }
        continue;
      }
      console.error(`[auto-close-combo-worker #${job.id}] error ${nextCount}/${ERROR_THRESHOLD}:`, err.message);
      if (nextCount >= ERROR_THRESHOLD) {
        try {
          await _log(job.id, `Fatal error after ${nextCount} consecutive failures: ${err.message}`);
          await _setStatus(job.id, "failed", { error_msg: err.message, completed: true });
        } catch {}
      } else {
        try { await pool.query(`UPDATE auto_close_combo_jobs SET consecutive_errors=? WHERE id=?`, [nextCount, job.id]); } catch {}
      }
    }
  }
}

async function _processComboJob(job) {
  // ── ACTIVE: monitor combined equity ─────────────────────────────────────────
  if (job.status === "active") {
    // A leg's option can expire before the combined target is ever hit —
    // Deribit settles it automatically with no order of ours involved.
    // Without this check the job would keep polling equity forever while
    // that leg's futures hedge sits un-managed (the "expired" handling in
    // the closing phase only runs once we're already there). If ANY leg has
    // expired, escalate the whole combo to closing now — the closing phase
    // already handles each leg's own expired/flat position correctly via
    // positionFlat, this just makes sure it starts instead of waiting on an
    // equity target a dead leg may never let it reach.
    const { base: authBase } = await auth(job.account_id);
    const [activeLegs] = await pool.query(
      `SELECT * FROM auto_close_combo_legs WHERE combo_job_id=? ORDER BY leg_index`, [job.id]
    );
    for (const leg of activeLegs) {
      if (parseFloat(leg.opt_qty || 0) === 0) continue;
      if (await isOptionExpired(authBase, leg.opt_instrument)) {
        await _log(job.id, `Leg ${leg.leg_index + 1} option ${leg.opt_instrument} has expired — moving the whole combo to closing.`);
        await sendTelegramAlert(
          [
            `⏰ <b>Strike Expired</b> — Combo Job #${job.id}`,
            `Leg ${leg.leg_index + 1} (${leg.leg_type || "?"}): ${leg.opt_instrument} expired before the +$${parseFloat(job.target_pnl).toFixed(2)} target was reached.`,
            `Closing all legs now.`,
          ].join("\n")
        );
        await _setStatus(job.id, "closing", { triggered: true });
        return;
      }
    }

    const col       = await collateral(job.account_id, job.token);
    const pnl       = col.total_usd - parseFloat(job.initial_total_usd);
    const targetPnl = parseFloat(job.target_pnl);

    await pool.query(
      `UPDATE auto_close_combo_jobs SET last_checked_at=NOW(), last_equity_usd=? WHERE id=?`,
      [col.total_usd, job.id]
    );

    if (!job.approach_alert_sent && targetPnl > 0 && pnl >= targetPnl * APPROACH_THRESHOLD) {
      await pool.query(`UPDATE auto_close_combo_jobs SET approach_alert_sent=1 WHERE id=?`, [job.id]);
      await sendTelegramAlert(
        [
          `⚠️ <b>Combo Auto-Close Approaching Target</b> — Job #${job.id}`,
          `PnL: +$${pnl.toFixed(2)} / target +$${targetPnl.toFixed(2)} (${((pnl / targetPnl) * 100).toFixed(1)}%)`,
          `Auto-close will trigger soon — keep an eye on it.`,
        ].join("\n")
      );
    }

    if (col.total_usd >= parseFloat(job.target_total_usd)) {
      await _log(job.id,
        `TARGET HIT — ${col.coin_symbol} $${col.coin_equity_usd.toFixed(2)} + USDC $${col.usdc_equity.toFixed(2)} = $${col.total_usd.toFixed(2)} | PnL +$${pnl.toFixed(2)}`
      );
      await _setStatus(job.id, "closing", { triggered: true });
    }
    return;
  }

  // ── CLOSING: work through every leg's option (maker) then futures (market) ──
  if (job.status === "closing") {
    const { base, token } = await auth(job.account_id);
    const [legs] = await pool.query(
      `SELECT * FROM auto_close_combo_legs WHERE combo_job_id=? ORDER BY leg_index`, [job.id]
    );

    let allDone = true;
    for (const leg of legs) {
      const optQty  = parseFloat(leg.opt_qty || 0);
      const futQty  = parseFloat(leg.fut_qty || 0);
      const optDone = optQty === 0 || !!leg.opt_done;
      const futDone = futQty === 0 || !!leg.fut_done;

      if (optQty !== 0 && !optDone) {
        allDone = false;
        await _closeLegOption(job.id, base, token, leg);
        continue;
      }
      if (futQty !== 0 && !futDone) {
        allDone = false;
        await _closeLegFutures(job.id, base, token, leg);
        continue;
      }
      // Zero-qty side never got flagged done — flag it now so allDone settles.
      if (optQty === 0 && !leg.opt_done) {
        await pool.query(`UPDATE auto_close_combo_legs SET opt_done=1 WHERE id=?`, [leg.id]);
      }
      if (futQty === 0 && !leg.fut_done) {
        await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1 WHERE id=?`, [leg.id]);
      }
    }

    if (allDone) {
      await _setStatus(job.id, "completed", { completed: true });
      await _finishComboJob(job.id);
    }
    return;
  }
}

// ─── Per-leg closing (option: maker/chase, futures: market) ───────────────────
// Mirrors _closeOption/_closeFutures in auto-close-worker.js exactly, just
// reading/writing a leg row instead of a single-leg job row.

async function _closeLegOption(comboJobId, base, token, leg) {
  const optQty = parseFloat(leg.opt_qty);

  if (await positionFlat(base, token, leg.opt_instrument)) {
    let closePrice = null;
    if (leg.opt_order_id) {
      try {
        const state = await rpc(base, "private/get_order_state", { order_id: leg.opt_order_id }, token);
        closePrice = parseFloat(state.average_price ?? state.price ?? 0) || null;
      } catch (e) { /* order no longer queryable — leave unknown */ }
    }
    await _log(comboJobId,
      `Leg ${leg.leg_index + 1} option position flat (${leg.opt_instrument})${closePrice != null ? ` — filled @ ${closePrice}` : " — expired/settled or closed outside the worker"}.`
    );
    const parts = ["opt_done=1"];
    const vals  = [];
    if (closePrice != null) { parts.push("opt_close_price=?"); vals.push(closePrice); }
    vals.push(leg.id);
    await pool.query(`UPDATE auto_close_combo_legs SET ${parts.join(", ")} WHERE id=?`, vals);
    return;
  }

  if (leg.opt_order_id) {
    const state = await rpc(base, "private/get_order_state", { order_id: leg.opt_order_id }, token);

    if (state.order_state === "filled") {
      const closePrice = parseFloat(state.average_price ?? state.price ?? 0);
      await _log(comboJobId, `Leg ${leg.leg_index + 1} option ${leg.opt_order_id} filled: ${leg.opt_instrument} @ ${closePrice}`);
      await pool.query(`UPDATE auto_close_combo_legs SET opt_done=1, opt_close_price=? WHERE id=?`, [closePrice, leg.id]);
      return;
    }

    if (state.order_state === "cancelled" || state.order_state === "rejected") {
      await _log(comboJobId, `Leg ${leg.leg_index + 1} option order ${state.order_state} — re-placing.`);
      await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=NULL WHERE id=?`, [leg.id]);
      return;
    }

    // Still open — re-quote at the current mark price if it has moved (chase)
    const res    = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(leg.opt_instrument)}`);
    const ticker = (await res.json()).result ?? {};
    const markPrice   = ticker.mark_price ?? 0;
    const orderPrice = parseFloat(state.price ?? 0);

    if (markPrice > 0 && Math.abs(markPrice - orderPrice) > OPT_REQUOTE_THRESHOLD) {
      await _log(comboJobId, `Leg ${leg.leg_index + 1} option mark price moved ${orderPrice.toFixed(5)} → ${markPrice.toFixed(5)}, re-quoting...`);
      try { await rpc(base, "private/cancel", { order_id: leg.opt_order_id }, token); } catch (e) { /* already filled/cancelled */ }
      await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=NULL WHERE id=?`, [leg.id]);
      const [[freshLeg]] = await pool.query(`SELECT * FROM auto_close_combo_legs WHERE id=?`, [leg.id]);
      await _closeLegOption(comboJobId, base, token, freshLeg);
    }
    return;
  }

  // No existing order — place new maker limit close at mid price
  const result  = await placeLimitClose(base, token, leg.opt_instrument, optQty, leg.opt_dir);
  const orderId = result.order?.order_id;
  const price   = result.order?.price;
  await _log(comboJobId, `Leg ${leg.leg_index + 1} option maker close placed: ${Math.abs(optQty)}x ${leg.opt_instrument} @ ${price} [order ${orderId}]`);
  await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=? WHERE id=?`, [orderId, leg.id]);
}

async function _closeLegFutures(comboJobId, base, token, leg) {
  const futQty = parseFloat(leg.fut_qty || 0);
  if (futQty === 0 || !leg.fut_instrument) {
    await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1 WHERE id=?`, [leg.id]);
    return;
  }

  if (await positionFlat(base, token, leg.fut_instrument)) {
    await _log(comboJobId, `Leg ${leg.leg_index + 1} futures position flat (${leg.fut_instrument}) — nothing left to close.`);
    await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1 WHERE id=?`, [leg.id]);
    return;
  }

  const result     = await placeMarketClose(base, token, leg.fut_instrument, futQty, leg.fut_dir);
  const closePrice = parseFloat(result.order?.average_price ?? result.order?.price ?? 0);
  await _log(comboJobId, `Leg ${leg.leg_index + 1} futures market close: ${Math.abs(futQty)}x ${leg.fut_instrument} @ ${closePrice}`);
  await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1, fut_close_price=? WHERE id=?`, [closePrice, leg.id]);
}

// Fetches a fresh final equity snapshot and sends the exit summary alert
// with a per-leg entry→close breakdown.
async function _finishComboJob(comboJobId) {
  try {
    const [[job]] = await pool.query(`SELECT * FROM auto_close_combo_jobs WHERE id=?`, [comboJobId]);
    if (!job) return;
    const [legs] = await pool.query(
      `SELECT * FROM auto_close_combo_legs WHERE combo_job_id=? ORDER BY leg_index`, [comboJobId]
    );

    const col         = await collateral(job.account_id, job.token).catch(() => null);
    const finalEquity = col?.total_usd ?? parseFloat(job.last_equity_usd ?? job.initial_total_usd);
    await pool.query(`UPDATE auto_close_combo_jobs SET final_equity_usd=? WHERE id=?`, [finalEquity, comboJobId]);

    const initial = parseFloat(job.initial_total_usd);
    const netDiff = finalEquity - initial;

    const legLines = legs.map(leg => {
      const optEntry = leg.opt_entry_price != null ? parseFloat(leg.opt_entry_price) : null;
      const optClose = leg.opt_close_price != null ? parseFloat(leg.opt_close_price) : null;
      const futEntry = leg.fut_entry_price != null ? parseFloat(leg.fut_entry_price) : null;
      const futClose = leg.fut_close_price != null ? parseFloat(leg.fut_close_price) : null;
      const parts = [`<b>Leg ${leg.leg_index + 1}</b> (${leg.leg_type || "?"}): ${leg.opt_instrument}`];
      if (optEntry != null) parts.push(`  Opt: $${optEntry.toFixed(4)} → ${optClose != null ? "$" + optClose.toFixed(4) : "—"}`);
      if (leg.fut_instrument && futEntry != null) parts.push(`  Fut: $${futEntry.toFixed(2)} → ${futClose != null ? "$" + futClose.toFixed(2) : "—"}`);
      return parts.join("\n");
    });

    const lines = [
      `✅ <b>Combo Auto-Close Complete</b> — Job #${comboJobId}`,
      ``,
      ...legLines,
      ``,
      `Initial collateral: $${initial.toFixed(2)}`,
      `Final collateral: $${finalEquity.toFixed(2)}`,
      `<b>Net PnL: ${netDiff >= 0 ? "+" : ""}$${netDiff.toFixed(2)}</b>`,
    ];

    await sendTelegramAlert(lines.join("\n"));
  } catch (e) {
    console.error(`[auto-close-combo-worker #${comboJobId}] finish-job alert failed:`, e.message);
  }
}

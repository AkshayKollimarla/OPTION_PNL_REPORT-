/**
 * Server-side auto-close background worker.
 * Polls every 5 s for active jobs, closes positions when equity target is hit.
 * Started once via instrumentation.js when the Next.js Node runtime initialises.
 */

import pool from "./options-db.js";
import { sendTelegramAlert } from "./telegram.js";
import {
  auth, collateral, positionFlat, isOptionExpired, placeLimitClose, placeMarketClose, rpc,
} from "./deribit-close-helpers.js";

const POLL_MS             = 5_000;
const APPROACH_THRESHOLD  = 0.9;         // send a heads-up once PnL hits 90% of target

// Survive Next.js dev-mode hot-reload (which resets plain module-level state
// on every file change) via a globalThis cache — same pattern as
// options-db.js. Without this, HMR could spawn duplicate polling intervals
// that both try to close the same position.
const _state = globalThis.__autoCloseWorkerState || (globalThis.__autoCloseWorkerState = {
  timer: null, running: false, tableEnsuredPromise: null, tickFn: null, createTableFn: null,
});

// ─── Public API ──────────────────────────────────────────────────────────────

// Idempotent, cached — safe to await from every API request. Guarantees the
// table exists before any query touches it, regardless of whether
// instrumentation.js has run yet (e.g. a dev server started before this
// worker existed, or a fresh production deploy against a fresh database).
//
// Same staleness hazard as startWorker() below: a resolved promise cached
// in globalThis survives hot-reload, so once ensured it would otherwise
// never re-run — meaning a later edit that adds new columns to _createTable
// would silently never apply them to an already-running dev server. Compare
// _createTable's identity to force a fresh migration pass when the code
// actually changed.
export function ensureAutoCloseTable() {
  if (_state.tableEnsuredPromise && _state.createTableFn === _createTable) {
    return _state.tableEnsuredPromise;
  }
  _state.createTableFn = _createTable;
  _state.tableEnsuredPromise = _createTable().catch(err => {
    _state.tableEnsuredPromise = null; // allow a retry on the next call
    throw err;
  });
  return _state.tableEnsuredPromise;
}

// Idempotent — safe to call from every API request. Ensures the polling
// loop is running even if instrumentation.js never fired for this process.
//
// _state.running alone isn't enough in dev: Next.js hot-reloads this module
// on every edit, which redefines _tick as a NEW function — but an already
// scheduled setInterval keeps calling the OLD closure forever, silently
// running stale logic until the whole process restarts. Comparing
// _state.tickFn against the current _tick detects that mismatch and
// restarts the loop cleanly, while still no-op'ing when nothing changed
// (so concurrent requests within one code version can't spawn duplicate
// intervals).
export function startWorker() {
  if (_state.running && _state.tickFn === _tick) return;
  if (_state.timer) clearInterval(_state.timer);
  _state.running = true;
  _state.tickFn  = _tick;
  ensureAutoCloseTable()
    .then(() => {
      console.log("[auto-close-worker] started (fresh tick loop)");
      _tick();
      _state.timer = setInterval(_tick, POLL_MS);
    })
    .catch(e => {
      console.error("[auto-close-worker] table init failed:", e.message);
      _state.running = false; // allow a retry on the next call
    });
}

export function stopWorker() {
  clearInterval(_state.timer); _state.timer = null; _state.running = false;
  console.log("[auto-close-worker] stopped");
}

// ─── DB bootstrap ────────────────────────────────────────────────────────────

async function _createTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auto_close_jobs (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      trade_id            INT NULL,
      account_id          INT NOT NULL,
      token               VARCHAR(50)  NOT NULL,
      opt_instrument      VARCHAR(100) NOT NULL,
      opt_qty             DECIMAL(12,6) NOT NULL,
      opt_dir             ENUM('buy','sell') NOT NULL,
      opt_entry_price     DECIMAL(18,8) NULL,
      opt_close_price     DECIMAL(18,8) NULL,
      fut_instrument      VARCHAR(100) NOT NULL DEFAULT '',
      fut_qty             DECIMAL(12,6) NOT NULL DEFAULT 0,
      fut_dir             ENUM('buy','sell') NOT NULL DEFAULT 'sell',
      fut_entry_price     DECIMAL(18,4) NULL,
      fut_close_price     DECIMAL(18,4) NULL,
      initial_total_usd   DECIMAL(14,4) NOT NULL,
      final_equity_usd    DECIMAL(14,4) NULL,
      target_pnl          DECIMAL(12,4) NOT NULL,
      target_total_usd    DECIMAL(14,4) NOT NULL,
      status              ENUM('active','closing_option','closing_futures','completed','failed','stopped')
                          NOT NULL DEFAULT 'active',
      opt_order_id        VARCHAR(100) NULL,
      opt_filled_qty      DECIMAL(12,6) NULL,
      opt_order_placed_at DATETIME NULL,
      approach_alert_sent TINYINT(1) NOT NULL DEFAULT 0,
      triggered_at        DATETIME NULL,
      completed_at        DATETIME NULL,
      last_checked_at     DATETIME NULL,
      last_equity_usd     DECIMAL(14,4) NULL,
      log_json            LONGTEXT NULL,
      error_msg           TEXT NULL,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Migrate columns for a table created before this feature existed
  for (const [col, def] of [
    ["opt_entry_price",     "DECIMAL(18,8) NULL"],
    ["opt_close_price",     "DECIMAL(18,8) NULL"],
    ["fut_entry_price",     "DECIMAL(18,4) NULL"],
    ["fut_close_price",     "DECIMAL(18,4) NULL"],
    ["final_equity_usd",    "DECIMAL(14,4) NULL"],
    ["approach_alert_sent", "TINYINT(1) NOT NULL DEFAULT 0"],
  ]) {
    try { await pool.query(`ALTER TABLE auto_close_jobs ADD COLUMN ${col} ${def}`); }
    catch { /* column already exists */ }
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function _log(jobId, msg) {
  const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(`[auto-close-worker #${jobId}]`, msg);
  try {
    await pool.query(
      `UPDATE auto_close_jobs
         SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?)
       WHERE id = ?`,
      [line, jobId]
    );
  } catch (e) {
    // Fallback if JSON_ARRAY_APPEND not supported (MySQL < 5.7.22)
    const [[row]] = await pool.query(`SELECT log_json FROM auto_close_jobs WHERE id=?`, [jobId]);
    let arr = [];
    try { arr = JSON.parse(row?.log_json || "[]"); } catch {}
    arr.push(line);
    await pool.query(`UPDATE auto_close_jobs SET log_json=? WHERE id=?`, [JSON.stringify(arr), jobId]);
  }
}

async function _setStatus(jobId, status, extras = {}) {
  const parts = ["status=?"];
  const vals  = [status];
  if (extras.opt_order_id !== undefined) { parts.push("opt_order_id=?");        vals.push(extras.opt_order_id); }
  if (extras.opt_filled_qty !== undefined) { parts.push("opt_filled_qty=?");    vals.push(extras.opt_filled_qty); }
  if (extras.opt_close_price !== undefined) { parts.push("opt_close_price=?"); vals.push(extras.opt_close_price); }
  if (extras.fut_close_price !== undefined) { parts.push("fut_close_price=?"); vals.push(extras.fut_close_price); }
  if (extras.triggered)   { parts.push("triggered_at=NOW()"); }
  if (extras.completed)   { parts.push("completed_at=NOW()"); }
  if (extras.opt_placed)  { parts.push("opt_order_placed_at=NOW()"); }
  if (extras.error_msg)   { parts.push("error_msg=?"); vals.push(extras.error_msg); }
  vals.push(jobId);
  await pool.query(`UPDATE auto_close_jobs SET ${parts.join(", ")} WHERE id=?`, vals);
}

// ─── Main poll tick ───────────────────────────────────────────────────────────

async function _tick() {
  let jobs;
  try {
    [jobs] = await pool.query(
      `SELECT * FROM auto_close_jobs WHERE status IN ('active','closing_option','closing_futures')`
    );
  } catch (e) {
    console.error("[auto-close-worker] DB query failed:", e.message);
    return;
  }

  for (const job of jobs) {
    try {
      await _processJob(job);
    } catch (err) {
      console.error(`[auto-close-worker #${job.id}] unhandled:`, err.message);
      try {
        await _log(job.id, `Fatal error: ${err.message}`);
        await _setStatus(job.id, "failed", { error_msg: err.message, completed: true });
      } catch {}
    }
  }
}

async function _processJob(job) {
  // ── ACTIVE: monitor equity ──────────────────────────────────────────────────
  if (job.status === "active") {
    // The option can expire before the profit target is ever hit — Deribit
    // settles it automatically with no order of ours involved. Without this
    // check the job would keep polling equity forever while the futures
    // hedge sits there un-managed, since the "expired" handling elsewhere
    // only runs once we're already in the closing phase.
    const { base: authBase } = await auth(job.account_id);
    if (await isOptionExpired(authBase, job.opt_instrument)) {
      await _log(job.id, `Option ${job.opt_instrument} has expired — closing the futures hedge and ending the monitor.`);
      await sendTelegramAlert(
        [
          `⏰ <b>Strike Expired</b> — Job #${job.id}`,
          `${job.opt_instrument} expired before the +$${parseFloat(job.target_pnl).toFixed(2)} target was reached.`,
          job.fut_instrument ? `Closing the futures hedge (${job.fut_instrument}) now.` : `No futures hedge to close.`,
        ].join("\n")
      );
      const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
      await _setStatus(job.id, hasFutures ? "closing_futures" : "completed", hasFutures ? {} : { completed: true });
      if (hasFutures) {
        const [[fresh]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [job.id]);
        await _closeFutures(fresh);
      } else {
        await _finishJob(job.id);
      }
      return;
    }

    const col       = await collateral(job.account_id, job.token);
    const pnl       = col.total_usd - parseFloat(job.initial_total_usd);
    const targetPnl = parseFloat(job.target_pnl);

    await pool.query(
      `UPDATE auto_close_jobs SET last_checked_at=NOW(), last_equity_usd=? WHERE id=?`,
      [col.total_usd, job.id]
    );

    // Heads-up alert once PnL crosses the threshold — gives the user time to
    // actively watch the close execute, before it actually triggers below.
    if (!job.approach_alert_sent && targetPnl > 0 && pnl >= targetPnl * APPROACH_THRESHOLD) {
      await pool.query(`UPDATE auto_close_jobs SET approach_alert_sent=1 WHERE id=?`, [job.id]);
      await sendTelegramAlert(
        [
          `⚠️ <b>Auto-Close Approaching Target</b> — Job #${job.id}`,
          `${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`,
          ``,
          `PnL: +$${pnl.toFixed(2)} / target +$${targetPnl.toFixed(2)} (${((pnl / targetPnl) * 100).toFixed(1)}%)`,
          `Auto-close will trigger soon — keep an eye on it.`,
        ].join("\n")
      );
    }

    if (col.total_usd >= parseFloat(job.target_total_usd)) {
      await _log(job.id,
        `TARGET HIT — ${col.coin_symbol} $${col.coin_equity_usd.toFixed(2)} + USDC $${col.usdc_equity.toFixed(2)} = $${col.total_usd.toFixed(2)} | PnL +$${pnl.toFixed(2)}`
      );
      await _setStatus(job.id, "closing_option", { triggered: true });
      // Re-fetch fresh row and proceed immediately
      const [[fresh]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [job.id]);
      await _closeOption(fresh);
    }
    return;
  }

  // ── CLOSING_OPTION: place / track option close order ───────────────────────
  if (job.status === "closing_option") {
    await _closeOption(job);
    return;
  }

  // ── CLOSING_FUTURES: market-close the hedge ─────────────────────────────────
  if (job.status === "closing_futures") {
    await _closeFutures(job);
    return;
  }
}

// Options always close as a maker at the mid price — never falls back to
// market. If the order sits unfilled, it re-quotes at the current mid every
// tick (5s), same chase behavior as the entry engine. Futures still close
// at market (accepted — the hedge needs to come off immediately once the
// option leg is done).
const OPT_REQUOTE_THRESHOLD = 0.00005;

async function _closeOption(job) {
  const { base, token } = await auth(job.account_id);
  const optQty = parseFloat(job.opt_qty);

  // Reconcile against the real position first — see positionFlat in
  // deribit-close-helpers.js.
  if (await positionFlat(base, token, job.opt_instrument)) {
    // Most common cause: our own maker order filled between ticks and this
    // check just noticed before the order-state branch below got a chance
    // to record the fill price. Look the order up so the exit alert still
    // shows an accurate close price instead of "—", before falling back to
    // "unknown" only if that lookup genuinely can't tell us (e.g. it really
    // did expire/settle with no order of ours involved).
    let closePrice = null;
    if (job.opt_order_id) {
      try {
        const state = await rpc(base, "private/get_order_state", { order_id: job.opt_order_id }, token);
        closePrice = parseFloat(state.average_price ?? state.price ?? 0) || null;
      } catch (e) { /* order no longer queryable — leave unknown */ }
    }
    await _log(job.id, `Option position already flat (${job.opt_instrument})${closePrice != null ? ` — filled @ ${closePrice}` : " — expired/settled or closed outside the worker"}.`);
    const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
    await _setStatus(job.id, hasFutures ? "closing_futures" : "completed", {
      ...(closePrice != null ? { opt_close_price: closePrice } : {}),
      ...(hasFutures ? {} : { completed: true }),
    });
    if (hasFutures) {
      const [[fresh]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [job.id]);
      await _closeFutures(fresh);
    } else {
      await _finishJob(job.id);
    }
    return;
  }

  // If there's an existing order, check its state
  if (job.opt_order_id) {
    const state = await rpc(base, "private/get_order_state",
      { order_id: job.opt_order_id }, token
    );

    if (state.order_state === "filled") {
      const filled     = parseFloat(state.filled_amount ?? state.amount ?? Math.abs(optQty));
      const closePrice = parseFloat(state.average_price ?? state.price ?? 0);
      const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
      await _log(job.id, `Option order ${job.opt_order_id} filled: ${filled}x ${job.opt_instrument} @ ${closePrice}`);
      await _setStatus(job.id,
        hasFutures ? "closing_futures" : "completed",
        { opt_filled_qty: filled, opt_close_price: closePrice, ...(hasFutures ? {} : { completed: true }) }
      );
      if (hasFutures) {
        const [[fresh]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [job.id]);
        await _closeFutures(fresh);
      } else {
        await _finishJob(job.id);
      }
      return;
    }

    if (state.order_state === "cancelled" || state.order_state === "rejected") {
      // Cancelled/rejected outside our control (e.g. margin) — clear and
      // let the next tick place a fresh maker order.
      await _log(job.id, `Option order ${job.opt_order_id} ${state.order_state} — re-placing.`);
      await pool.query(`UPDATE auto_close_jobs SET opt_order_id=NULL WHERE id=?`, [job.id]);
      return;
    }

    // Still open — re-quote at the current mid if it has moved (chase, like the entry engine)
    const res    = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(job.opt_instrument)}`);
    const ticker = (await res.json()).result ?? {};
    const bid    = ticker.best_bid_price ?? 0;
    const ask    = ticker.best_ask_price ?? 0;
    const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ticker.mark_price ?? 0);
    const orderPrice = parseFloat(state.price ?? 0);

    if (mid > 0 && Math.abs(mid - orderPrice) > OPT_REQUOTE_THRESHOLD) {
      await _log(job.id, `Option mid moved ${orderPrice.toFixed(5)} → ${mid.toFixed(5)}, re-quoting maker order...`);
      try {
        await rpc(base, "private/cancel", { order_id: job.opt_order_id }, token);
      } catch (e) { /* already filled/cancelled — ignore, next tick will see the real state */ }
      await pool.query(`UPDATE auto_close_jobs SET opt_order_id=NULL WHERE id=?`, [job.id]);
      const [[fresh]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [job.id]);
      await _closeOption(fresh);
    }
    // Otherwise: still resting at the right price — next tick will check again
    return;
  }

  // No existing order — place new maker limit close at mid price
  const result = await placeLimitClose(base, token, job.opt_instrument, optQty, job.opt_dir);
  const orderId = result.order?.order_id;
  const price   = result.order?.price;
  await _log(job.id, `Option maker close placed: ${Math.abs(optQty)}x ${job.opt_instrument} @ ${price} [order ${orderId}]`);
  await _setStatus(job.id, "closing_option", { opt_order_id: orderId, opt_placed: true });
}

async function _closeFutures(job) {
  const futQty = parseFloat(job.fut_qty || 0);
  if (futQty === 0 || !job.fut_instrument) {
    await _log(job.id, "No futures position — strategy complete.");
    await _setStatus(job.id, "completed", { completed: true });
    await _finishJob(job.id);
    return;
  }
  const { base, token } = await auth(job.account_id);

  // Reconcile against the real position first — a duplicate/overlapping
  // tick (or the position already having been closed) would otherwise
  // place another close order on top of one that already went through.
  if (await positionFlat(base, token, job.fut_instrument)) {
    await _log(job.id, `Futures position already flat (${job.fut_instrument}) — nothing left to close.`);
    await _setStatus(job.id, "completed", { completed: true });
    await _finishJob(job.id);
    return;
  }

  const result     = await placeMarketClose(base, token, job.fut_instrument, futQty, job.fut_dir);
  const orderId    = result.order?.order_id;
  const closePrice = parseFloat(result.order?.average_price ?? result.order?.price ?? 0);
  await _log(job.id, `Futures market close placed: ${Math.abs(futQty)}x ${job.fut_instrument} @ ${closePrice} [order ${orderId}]`);
  await _setStatus(job.id, "completed", { completed: true, fut_close_price: closePrice });
  await _finishJob(job.id);
}

// Fetches a fresh final equity snapshot and sends the exit summary alert.
// Runs once, right after a job reaches its terminal "completed" status.
async function _finishJob(jobId) {
  try {
    const [[job]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [jobId]);
    if (!job) return;

    const col          = await collateral(job.account_id, job.token).catch(() => null);
    const finalEquity  = col?.total_usd ?? parseFloat(job.last_equity_usd ?? job.initial_total_usd);
    await pool.query(`UPDATE auto_close_jobs SET final_equity_usd=? WHERE id=?`, [finalEquity, jobId]);

    const initial  = parseFloat(job.initial_total_usd);
    const netDiff  = finalEquity - initial;
    const optEntry = job.opt_entry_price != null ? parseFloat(job.opt_entry_price) : null;
    const optClose = job.opt_close_price != null ? parseFloat(job.opt_close_price) : null;
    const futEntry = job.fut_entry_price != null ? parseFloat(job.fut_entry_price) : null;
    const futClose = job.fut_close_price != null ? parseFloat(job.fut_close_price) : null;

    const lines = [
      `✅ <b>Auto-Close Complete</b> — Job #${jobId}`,
      `${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`,
      ``,
      optEntry != null
        ? `Option: entry $${optEntry.toFixed(4)} → close ${optClose != null ? "$" + optClose.toFixed(4) : "—"}`
        : null,
      job.fut_instrument && futEntry != null
        ? `Futures: entry $${futEntry.toFixed(2)} → close ${futClose != null ? "$" + futClose.toFixed(2) : "—"}`
        : null,
      ``,
      `Initial collateral: $${initial.toFixed(2)}`,
      `Final collateral: $${finalEquity.toFixed(2)}`,
      `<b>Net PnL: ${netDiff >= 0 ? "+" : ""}$${netDiff.toFixed(2)}</b>`,
    ].filter(Boolean);

    await sendTelegramAlert(lines.join("\n"));
  } catch (e) {
    console.error(`[auto-close-worker #${jobId}] finish-job alert failed:`, e.message);
  }
}

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
  auth, collateral, positionFlat, livePositionSize, isOptionExpired, placeLimitClose, rpc,
  _fetchJsonOrOutage, invalidateAuth, orderAmount, instrumentMeta, adoptOrCleanupCloseOrders, effectiveTick, roundToTick, closePriceFor, placeLimitCloseAt,
} from "./deribit-close-helpers.js";

const POLL_MS             = 2_000;       // tightened from 5s — less price drift between an equity trigger and actually closing
const APPROACH_THRESHOLD  = 0.9;
const OPT_REQUOTE_THRESHOLD = 0.00002;   // tightened from 0.00005 — chases smaller price moves
const ERROR_THRESHOLD     = 30;          // ~1 min of continuous failures before giving up (scaled with POLL_MS) — survives a brief network blip, doesn't mask a genuinely broken job for long
const STUCK_TICKS         = 150;         // ~5 min at POLL_MS with an option order open and unfilled → alert once, keep chasing (never cross the spread)

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
    // initial_total_usd holds the tracked baseline, whose meaning depends on
    // monitor_mode: 'coin' → coin-only equity (BTC/ETH), 'combined' → whole
    // account (coin + USDC), same as the pre-coin-only-tracking behavior.
    // initial_usdc_equity_usd is purely informational in 'coin' mode, never
    // used in the trigger math.
    ["initial_usdc_equity_usd", "DECIMAL(14,4) NULL"],
    ["monitor_mode", "ENUM('coin','combined') NOT NULL DEFAULT 'coin'"],
    // 'target' — the original flow: watch equity, close when target_pnl hits.
    // 'manual' — user pressed Exit All: created already in 'closing', with no
    // target to watch. Kept distinct because manual exits get behavior target
    // jobs must NOT have (notably the final futures sweep, which on a target
    // job could close a hedge belonging to another strategy on the same
    // account).
    ["job_kind", "ENUM('target','manual') NOT NULL DEFAULT 'target'"],
    // Seconds a leg may sit unfilled as a passive maker before its close
    // order is re-placed at the opposite touch (crossing the spread) to
    // guarantee a fill. NULL keeps the original behavior: stay passive
    // indefinitely and never cross.
    ["cross_after_secs", "INT NULL"],
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

  for (const [col, def] of [
    // Cumulative futures already closed for THIS leg, in Deribit "amount"
    // units. Tracked in the DB rather than derived from the live position
    // because a futures instrument (ETH-PERPETUAL) is shared across legs —
    // its live size is the combined remaining exposure and says nothing
    // about how much of any single leg's hedge has been lifted.
    ["fut_closed_qty", "DECIMAL(18,6) NOT NULL DEFAULT 0"],
    // Option size at the moment closing began. The fill ratio is measured
    // against this, not against the live size (which shrinks as it fills)
    // and not against opt_qty (which for a manual exit may differ from
    // what's actually open on the exchange).
    ["opt_start_qty", "DECIMAL(18,6) NULL"],
    // Re-quote attempts with no fill, and a once-only guard for the stuck
    // alert, so a leg with no bid doesn't spam Telegram every 2s.
    ["requote_count", "INT NOT NULL DEFAULT 0"],
    ["stuck_alert_sent", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Legs only start closing once every leg in a LOWER phase is finished.
    // Manual exits use this to buy back short options (phase 0) before
    // selling the longs that protect them (phase 1) — unwinding a spread in
    // the other order leaves a naked short, with a margin spike and unbounded
    // risk on a short call, for however long the second leg takes to fill.
    // Unmatched leftover futures sweep last (phase 2). Target-based jobs
    // leave every leg at the default 0, so they keep closing concurrently
    // exactly as before.
    ["close_phase", "INT NOT NULL DEFAULT 0"],
    // "close whatever is still open on this futures instrument, ignore
    // fut_qty". A manual exit means flat, but per-leg hedge quantities come
    // from saved strategy rows that can under-account for what's actually on
    // the exchange — one live account carries both BTC-PERPETUAL and
    // BTC_USDC-PERPETUAL while its saved row references only one. A sweep
    // leg in the final phase mops up whatever the proportional legs didn't
    // claim, so "Exit All" genuinely ends flat.
    ["fut_sweep", "TINYINT(1) NOT NULL DEFAULT 0"],
    // The price this leg first crossed at. Crossing is meant to pay the
    // SPREAD — one level — not to sweep the book. Without remembering it, a
    // partial fill that consumes the touch leaves the next tick looking at a
    // worse touch, re-quoting there, and repeating: a real book reads
    // 0.8 x 110 | 0.7 x 1960 | 0.3 x 90, so an order could walk itself down
    // to 0.3 against a 0.83 mark. Held as a floor (sell) / ceiling (buy) so
    // the fill can only ever improve on it.
    ["cross_price", "DECIMAL(18,8) NULL"],
    // Futures now close as chased maker orders too, so that side needs the
    // same tracking the option side has: the working order, how long it has
    // been unfilled (drives the cross-the-spread timer), and the level it
    // committed to when it crossed. fut_closed_qty already existed and is
    // now credited from ACTUAL fills rather than assumed complete, which a
    // market order could take for granted and a resting maker cannot.
    ["fut_order_id", "VARCHAR(100) NULL"],
    ["fut_requote_count", "INT NOT NULL DEFAULT 0"],
    ["fut_cross_price", "DECIMAL(18,8) NULL"],
  ]) {
    try { await pool.query(`ALTER TABLE auto_close_combo_legs ADD COLUMN ${col} ${def}`); }
    catch { /* column already exists */ }
  }
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

// setInterval fires on a fixed 2s cadence regardless of whether the previous
// tick has finished, and a tick is deeply async — it fetches positions, order
// state and tickers, then places orders. Whenever a tick ran longer than
// POLL_MS the next one started ON TOP of it, and because a leg's opt_order_id
// is only written AFTER its order comes back, both ticks read it as NULL,
// both concluded "no order working", and both placed one.
//
// Confirmed in production: a manual exit on SOL_USDC put two identical
// SOL_USDC-7AUG26-70-P sell orders (2 contracts @ 0.6) on the book, and every
// leg still showed opt_order_id NULL because the concurrent writes raced. The
// duplicate is not reduce_only-protected either — both orders were valid
// reduce_only sells against the same position, so filling both would have
// closed twice as much as intended.
//
// This guard makes a tick skip entirely while the previous one is still in
// flight, which is always safe: the work is idempotent across ticks and the
// next fire picks it up 2s later.
async function _tick() {
  if (_state.ticking) return;
  _state.ticking = true;
  try {
    await _tickBody();
  } finally {
    _state.ticking = false;
  }
}

async function _tickBody() {
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
        // minute so a long outage doesn't flood log_json with a line every 2s.
        console.error(`[auto-close-combo-worker #${job.id}] Deribit appears to be down (attempt ${nextCount}), not counted toward the failure limit:`, err.message);
        try { await pool.query(`UPDATE auto_close_combo_jobs SET consecutive_errors=? WHERE id=?`, [nextCount, job.id]); } catch {}
        if (nextCount % 30 === 1) {
          try { await _log(job.id, `Deribit appears to be under maintenance/unreachable — still retrying (${nextCount} attempts so far), job stays active.`); } catch {}
        }
        continue;
      }
      console.error(`[auto-close-combo-worker #${job.id}] error ${nextCount}/${ERROR_THRESHOLD}:`, err.message);
      // "unauthorized (code 13009)" means the cached token is dead — force a
      // fresh public/auth on the very next tick instead of retrying the same
      // stale token for up to another AUTH_CACHE_TTL_MS.
      if (/unauthorized|code 13009/i.test(err.message)) invalidateAuth(job.account_id);
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

    const col = await collateral(job.account_id, job.token);
    // monitor_mode picks the tracked basis (chosen at execution time, per
    // job) — see the single-leg worker for the full rationale. Pure-USDC
    // tokens have no separate coin wallet, so both modes are identical.
    const isCoinMargined = col.coin_symbol !== "USDC";
    const useCoinOnly     = isCoinMargined && job.monitor_mode !== "combined";
    const currentBasis    = useCoinOnly ? col.coin_equity_usd : col.total_usd;
    const pnl              = currentBasis - parseFloat(job.initial_total_usd);
    const targetPnl         = parseFloat(job.target_pnl);

    await pool.query(
      `UPDATE auto_close_combo_jobs SET last_checked_at=NOW(), last_equity_usd=? WHERE id=?`,
      [currentBasis, job.id]
    );

    if (!job.approach_alert_sent && targetPnl > 0 && pnl >= targetPnl * APPROACH_THRESHOLD) {
      await pool.query(`UPDATE auto_close_combo_jobs SET approach_alert_sent=1 WHERE id=?`, [job.id]);
      await sendTelegramAlert(
        [
          `⚠️ <b>Combo Auto-Close Approaching Target</b> — Job #${job.id}`,
          `PnL: +$${pnl.toFixed(2)} / target +$${targetPnl.toFixed(2)} (${((pnl / targetPnl) * 100).toFixed(1)}%)${useCoinOnly ? ` — ${col.coin_symbol} equity only` : " — combined coin+USDC"}`,
          `Auto-close will trigger soon — keep an eye on it.`,
        ].join("\n")
      );
    }

    if (currentBasis >= parseFloat(job.target_total_usd)) {
      await _log(job.id,
        `TARGET HIT (${useCoinOnly ? col.coin_symbol + "-only" : "combined"}) — ${col.coin_symbol} equity $${col.coin_equity_usd.toFixed(2)} | USDC $${col.usdc_equity.toFixed(2)}${useCoinOnly ? " (reference only)" : ""} | PnL +$${pnl.toFixed(2)}`
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

    // Work the lowest phase that still has anything open, and only that
    // phase. Target jobs leave every leg at phase 0, so this collapses to
    // "all legs, concurrently" and their behavior is unchanged. Manual exits
    // use it to finish buying back short options before selling the longs
    // that protect them.
    const legHasFutures = (l) => parseFloat(l.fut_qty || 0) !== 0 || !!l.fut_sweep;
    const legIncomplete = (l) => {
      const oq = parseFloat(l.opt_qty || 0);
      return (oq !== 0 && !l.opt_done) || (legHasFutures(l) && !l.fut_done);
    };
    const phases = [...new Set(legs.map(l => l.close_phase ?? 0))].sort((a, b) => a - b);
    const activePhase = phases.find(ph => legs.some(l => (l.close_phase ?? 0) === ph && legIncomplete(l)));

    let allDone = activePhase === undefined;
    for (const leg of legs) {
      if ((leg.close_phase ?? 0) !== activePhase) continue;
      const optQty  = parseFloat(leg.opt_qty || 0);
      const hasFut  = legHasFutures(leg);
      const optDone = optQty === 0 || !!leg.opt_done;
      const futDone = !hasFut || !!leg.fut_done;

      // Option and futures both advance on the SAME tick. They used to be
      // sequential (futures only after the option leg was fully done), but
      // the hedge now comes off in proportion to the option's fill, so it
      // has to be able to move while the option is still closing. Ordering
      // within the tick still matters: the option runs first so the futures
      // step sees the freshest possible fill ratio.
      if (optQty !== 0 && !optDone) {
        allDone = false;
        await _closeLegOption(job.id, base, token, leg, job.cross_after_secs);
      }
      if (hasFut && !futDone) {
        allDone = false;
        await _closeLegFutures(job.id, base, token, leg, job.cross_after_secs);
      }
      if ((optQty !== 0 && !optDone) || (hasFut && !futDone)) continue;
      // Zero-qty side never got flagged done — flag it now so allDone settles.
      if (optQty === 0 && !leg.opt_done) {
        await pool.query(`UPDATE auto_close_combo_legs SET opt_done=1 WHERE id=?`, [leg.id]);
      }
      if (!hasFut && !leg.fut_done) {
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

// Crossing pays the spread — ONE level — it does not sweep the book. Once a
// leg has crossed, the price it committed to becomes a bound: a sell may
// never be re-quoted lower, a buy never higher. Without that bound a partial
// fill that consumes the touch would leave the next tick facing a worse touch
// and re-quoting there, walking the order down level by level.
async function _closePriceForLeg(base, leg, shouldCross) {
  const { price, crossed } = await closePriceFor(base, leg.opt_instrument, leg.opt_dir, shouldCross);
  if (!crossed) return { price, crossed };
  const prev = leg.cross_price != null ? parseFloat(leg.cross_price) : null;
  if (prev == null || !Number.isFinite(prev)) return { price, crossed };
  const bounded = leg.opt_dir === "buy" ? Math.min(price, prev) : Math.max(price, prev);
  return { price: bounded, crossed };
}

async function _closeLegOption(comboJobId, base, token, leg, crossAfterSecs = null) {
  const optQty = parseFloat(leg.opt_qty);

  // How long this leg has been trying, measured in ticks rather than wall
  // clock: requote_count increments once per poll, so ticks x POLL_MS is the
  // elapsed time the order has spent unfilled. Past the user's patience
  // window the leg stops resting passively and crosses the spread instead.
  // crossAfterSecs null (the default) preserves maker-only forever.
  const waitedSecs  = ((parseInt(leg.requote_count, 10) || 0) * POLL_MS) / 1000;
  const shouldCross = crossAfterSecs != null && waitedSecs >= Number(crossAfterSecs);

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
    const ticker = (await _fetchJsonOrOutage(`${base}/public/ticker?instrument_name=${encodeURIComponent(leg.opt_instrument)}`)).result ?? {};
    const markPrice   = ticker.mark_price ?? 0;
    const orderPrice = parseFloat(state.price ?? 0);

    // A deep-OTM leg can sit unfilled indefinitely: a maker order priced at
    // mark never fills when there's no bid anywhere near mark (a real leg on
    // this account marks at $0.00004). The policy is to keep chasing rather
    // than cross the spread, so the only correct response is to say so —
    // once — and let the position be closed by hand if desired. Counted in
    // ticks rather than re-quotes because a stuck leg's mark often isn't
    // moving at all, so it would never re-quote and never trip the alert.
    const waited = (parseInt(leg.requote_count, 10) || 0) + 1;
    await pool.query(`UPDATE auto_close_combo_legs SET requote_count=? WHERE id=?`, [waited, leg.id]);
    if (waited >= STUCK_TICKS && !leg.stuck_alert_sent) {
      await pool.query(`UPDATE auto_close_combo_legs SET stuck_alert_sent=1 WHERE id=?`, [leg.id]);
      const mins = Math.round((STUCK_TICKS * POLL_MS) / 60000);
      const filled = parseFloat(state.filled_amount ?? 0);
      await _log(comboJobId, `Leg ${leg.leg_index + 1} option has not filled after ~${mins} min — still chasing mark, no spread crossing.`);
      await sendTelegramAlert(
        [
          `⏳ <b>Exit leg not filling</b> — Combo Job #${comboJobId}`,
          `${leg.opt_instrument}`,
          ``,
          `No fill after ~${mins} minutes of maker re-quoting${filled > 0 ? ` (${filled} filled so far)` : ""}.`,
          `Mark is ${markPrice} — likely little or no bid at that level.`,
          ``,
          `Still chasing the mark; the spread will not be crossed automatically.`,
          `Close it manually on Deribit if you want out sooner.`,
        ].join("\n")
      );
    }

    // Compare against the price this order WOULD be placed at now, not the raw
    // mark. placeLimitClose snaps to the instrument's tick (floor for a buy,
    // ceil for a sell), so a resting order sits up to a full tick away from
    // mark BY DESIGN. Comparing the raw mark to that snapped price meant the
    // gap was permanently larger than the threshold on any instrument with a
    // coarse tick — SOL_USDC options tick at 0.1 against a ~0.25 premium — so
    // the leg cancelled and re-placed at the IDENTICAL price every 2s
    // forever, surrendering queue position each time and never filling.
    // Confirmed live: 41 consecutive ticks, "0.20000 → 0.24800, re-quoting"
    // then re-placing at 0.2, with zero fills.
    // Once the patience window has elapsed the target becomes the opposite
    // touch, so this same comparison moves the order across the spread.
    const { price: targetPrice } = await _closePriceForLeg(base, leg, shouldCross);
    if (markPrice > 0 && Math.abs(targetPrice - orderPrice) > OPT_REQUOTE_THRESHOLD) {
      await _log(comboJobId, `Leg ${leg.leg_index + 1} option mark price moved ${orderPrice.toFixed(5)} → ${markPrice.toFixed(5)}, re-quoting...`);
      try { await rpc(base, "private/cancel", { order_id: leg.opt_order_id }, token); } catch (e) { /* already filled/cancelled */ }
      await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=NULL WHERE id=?`, [leg.id]);
      const [[freshLeg]] = await pool.query(`SELECT * FROM auto_close_combo_legs WHERE id=?`, [leg.id]);
      await _closeLegOption(comboJobId, base, token, freshLeg, crossAfterSecs);
    }
    return;
  }

  // We think no order is working — but verify against the exchange before
  // adding one. A tracked id can be lost (process restart between placing and
  // persisting, failed write, or overlapping ticks racing the write), and
  // trusting local state alone is exactly what put duplicate reduce_only
  // sells on the same position.
  const adopted = await adoptOrCleanupCloseOrders(base, token, leg.opt_instrument, leg.opt_dir);
  if (adopted) {
    await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=? WHERE id=?`, [adopted.order.order_id, leg.id]);
    await _log(comboJobId,
      `Leg ${leg.leg_index + 1}: found an untracked close order already working on ${leg.opt_instrument} — adopted it${adopted.cancelledDuplicates ? ` and cancelled ${adopted.cancelledDuplicates} duplicate(s)` : ""} instead of placing another.`
    );
    return;
  }

  // No existing order — place new maker limit close at mark price. Use the
  // REAL live position size, not the stored opt_qty — an option instrument
  // is always exclusive to one leg, so live size is exactly this leg's
  // exposure. They can drift apart (partial fill, assignment, manual
  // intervention), and a reduce_only order sized larger than the actual
  // open position gets rejected by Deribit (invalid_reduce_only_order)
  // forever — a confirmed incident: a job spent 3+ minutes re-quoting and
  // failing on exactly this before exhausting the retry budget.
  const liveSize = await livePositionSize(base, token, leg.opt_instrument);
  if (liveSize === null) {
    await _log(comboJobId, `Leg ${leg.leg_index + 1}: could not confirm live position size for ${leg.opt_instrument} — skipping this tick, will retry.`);
    return;
  }
  if (liveSize === 0) {
    // Already flat — next tick's positionFlat() check at the top will pick
    // this up and mark the leg done.
    return;
  }

  // exactAmount=true — liveSize is already in Deribit's "amount" units.
  const { price: plannedPrice, crossed } = await _closePriceForLeg(base, leg, shouldCross);
  const result  = await placeLimitCloseAt(base, token, leg.opt_instrument, liveSize, leg.opt_dir, plannedPrice, true);
  const orderId = result.order?.order_id;
  const price   = result.order?.price;
  // Remember the level committed to on the FIRST cross; later ticks clamp to it.
  if (crossed && leg.cross_price == null) {
    await pool.query(`UPDATE auto_close_combo_legs SET cross_price=? WHERE id=?`, [plannedPrice, leg.id]);
  }
  await _log(comboJobId,
    shouldCross
      ? `Leg ${leg.leg_index + 1} option CROSSING the spread after ~${Math.round(waitedSecs)}s unfilled: ${liveSize}x ${leg.opt_instrument} @ ${price} [order ${orderId}]`
      : `Leg ${leg.leg_index + 1} option maker close placed: ${liveSize}x ${leg.opt_instrument} @ ${price} [order ${orderId}]`
  );
  await pool.query(`UPDATE auto_close_combo_legs SET opt_order_id=? WHERE id=?`, [orderId, leg.id]);
}

// Futures close as CHASED MAKER orders, not market orders. Deribit charges
// 0% maker against 0.05% taker on perpetuals, so every market close was
// paying a fee a resting order avoids. The cost is that a maker order isn't
// guaranteed to fill, so this side needs what the option side already has:
// a tracked working order, credit from ACTUAL fills rather than an
// assumed-complete market order, re-quoting as the touch moves, and the
// user's cross-after-N-seconds escape hatch.
async function _closeLegFutures(comboJobId, base, token, leg, crossAfterSecs = null) {
  const futQty = parseFloat(leg.fut_qty || 0);
  // A sweep leg carries no meaningful fut_qty — its size is whatever is
  // still open when it runs — so it must not be short-circuited here.
  if ((futQty === 0 && !leg.fut_sweep) || !leg.fut_instrument) {
    await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1 WHERE id=?`, [leg.id]);
    return;
  }

  const liveSize = await livePositionSize(base, token, leg.fut_instrument);
  if (liveSize === null) {
    await _log(comboJobId, `Leg ${leg.leg_index + 1}: could not confirm live futures size for ${leg.fut_instrument} — skipping this tick, will retry.`);
    return;
  }
  if (liveSize === 0) {
    await _log(comboJobId, `Leg ${leg.leg_index + 1} futures position flat (${leg.fut_instrument}) — nothing left to close.`);
    await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1, fut_order_id=NULL WHERE id=?`, [leg.id]);
    return;
  }

  // How much of the hedge is owed right now.
  //
  // The hedge comes off in step with the STRUCTURE, measured across every
  // option leg of this job — not against the single leg that happens to carry
  // fut_qty. A hedge is taken against the position as a whole, so the fraction
  // lifted has to track the fraction of the whole position that has closed.
  //
  // Measuring per-leg failed badly whenever the hedge sat on one leg, which is
  // how these get entered in practice: on a real 4-leg group only PUT 97 held
  // fut_qty, so closing the other 2000 lots lifted NOTHING (naked short until
  // that one leg moved), while closing PUT 97 first lifted the ENTIRE hedge
  // with 2000 lots still open. Aggregating fixes both: 2000 of 3000 lots
  // closed lifts 2/3 of the hedge no matter which legs filled.
  //
  // Each leg still closes its OWN fut_qty share, just scaled by the shared
  // ratio — so a hedge split across legs and a hedge parked on one leg both
  // total the same amount closed.
  const desiredTotal  = leg.fut_sweep ? null : await orderAmount(base, leg.fut_instrument, Math.abs(futQty));
  const alreadyClosed = parseFloat(leg.fut_closed_qty || 0);
  let   filledRatio   = 1;
  if (!leg.fut_sweep) {
    const [optLegs] = await pool.query(
      `SELECT opt_instrument, opt_start_qty, opt_qty FROM auto_close_combo_legs
        WHERE combo_job_id=? AND opt_instrument <> ''`,
      [comboJobId]
    );
    let totalStart = 0, totalLive = 0;
    for (const ol of optLegs) {
      const start = Math.abs(parseFloat(ol.opt_start_qty ?? ol.opt_qty ?? 0));
      if (!(start > 0)) continue;
      const live = await livePositionSize(base, token, ol.opt_instrument);
      if (live === null) {
        // One unknown leg makes the whole ratio wrong, and acting on a wrong
        // ratio moves real hedge size — so hold rather than guess.
        await _log(comboJobId, `Leg ${leg.leg_index + 1}: could not confirm live size for ${ol.opt_instrument} — holding the hedge until every option leg is known.`);
        return;
      }
      totalStart += start;
      totalLive  += Math.min(Math.abs(live), start);
    }
    if (totalStart > 0) {
      filledRatio = Math.min(1, Math.max(0, (totalStart - totalLive) / totalStart));
    }
  }
  const isFinalSlice = filledRatio >= 1;

  // Obligation already met? Decided here rather than at fill time because the
  // shared futures position never reaches zero while other legs still hold
  // their share — without this a proportional leg would never complete.
  if (!leg.fut_sweep && isFinalSlice && alreadyClosed >= desiredTotal - 1e-9) {
    if (leg.fut_order_id) {
      try { await rpc(base, "private/cancel", { order_id: leg.fut_order_id }, token); } catch { /* already gone */ }
    }
    await _log(comboJobId, `Leg ${leg.leg_index + 1} hedge fully lifted (${alreadyClosed}/${desiredTotal}).`);
    await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1, fut_order_id=NULL WHERE id=?`, [leg.id]);
    return;
  }

  const futWaitedSecs  = ((parseInt(leg.fut_requote_count, 10) || 0) * POLL_MS) / 1000;
  const futShouldCross = crossAfterSecs != null && futWaitedSecs >= Number(crossAfterSecs);
  // Same bound as the option side: once crossed, never re-quote to a worse
  // level, so a partial fill can't walk the order down the book.
  const futPriceNow = async () => {
    const { price, crossed } = await closePriceFor(base, leg.fut_instrument, leg.fut_dir, futShouldCross);
    if (!crossed) return { price, crossed };
    const prev = leg.fut_cross_price != null ? parseFloat(leg.fut_cross_price) : null;
    if (prev == null || !Number.isFinite(prev)) return { price, crossed };
    return { price: leg.fut_dir === "buy" ? Math.min(price, prev) : Math.max(price, prev), crossed };
  };

  // ── Reconcile the working order before placing another ──
  if (leg.fut_order_id) {
    let state = null;
    try { state = await rpc(base, "private/get_order_state", { order_id: leg.fut_order_id }, token); }
    catch { /* no longer queryable — treated as gone below */ }

    const filledNow = parseFloat(state?.filled_amount ?? 0) || 0;
    const fillPrice = parseFloat(state?.average_price ?? state?.price ?? 0) || null;
    const dead = !state || ["filled", "cancelled", "rejected"].includes(state.order_state);

    if (dead) {
      if (filledNow > 0) {
        await pool.query(
          `UPDATE auto_close_combo_legs SET fut_closed_qty=fut_closed_qty+?, fut_close_price=?, fut_order_id=NULL WHERE id=?`,
          [filledNow, fillPrice, leg.id]
        );
        await _log(comboJobId, `Leg ${leg.leg_index + 1} futures filled ${filledNow}x ${leg.fut_instrument} @ ${fillPrice}`);
      } else {
        await pool.query(`UPDATE auto_close_combo_legs SET fut_order_id=NULL WHERE id=?`, [leg.id]);
      }
      return; // next tick sizes the remainder against fresh state
    }

    // Still working — re-quote only when the price it WOULD be placed at now
    // has actually changed. Comparing against raw mark instead re-quoted every
    // tick at an identical price and never filled (see the option side).
    await pool.query(`UPDATE auto_close_combo_legs SET fut_requote_count=? WHERE id=?`,
      [(parseInt(leg.fut_requote_count, 10) || 0) + 1, leg.id]);
    const { price: target } = await futPriceNow();
    const resting = parseFloat(state.price ?? 0);
    if (target > 0 && Math.abs(target - resting) > 1e-9) {
      try { await rpc(base, "private/cancel", { order_id: leg.fut_order_id }, token); } catch { /* already gone */ }
      if (filledNow > 0) {
        await pool.query(
          `UPDATE auto_close_combo_legs SET fut_closed_qty=fut_closed_qty+?, fut_close_price=? WHERE id=?`,
          [filledNow, fillPrice, leg.id]
        );
      }
      await pool.query(`UPDATE auto_close_combo_legs SET fut_order_id=NULL WHERE id=?`, [leg.id]);
    }
    return;
  }

  // ── Size and place the next slice ──
  let toClose;
  if (leg.fut_sweep) {
    // No option to track a ratio against — close whatever remains. Runs in the
    // final phase, so the proportional legs have taken their shares already.
    toClose = liveSize;
  } else {
    toClose = Math.min(desiredTotal * filledRatio - alreadyClosed, liveSize);
    if (toClose <= 0) return; // option hasn't filled further since last tick

    // Deribit rejects anything under min_trade_amount, so a slice below it
    // waits and accumulates instead of being sent and bounced. The exception
    // is the last slice: no larger one is coming, so send what remains.
    const meta   = await instrumentMeta(base, leg.fut_instrument);
    const minAmt = meta?.min_trade_amount || 0;
    if (minAmt > 0 && toClose < minAmt) {
      if (!isFinalSlice) return;
      if (liveSize < minAmt) {
        await _log(comboJobId, `Leg ${leg.leg_index + 1} futures remainder ${liveSize} is below Deribit's minimum ${minAmt} — cannot close the dust, marking leg done.`);
        await pool.query(`UPDATE auto_close_combo_legs SET fut_done=1 WHERE id=?`, [leg.id]);
        return;
      }
      toClose = Math.min(minAmt, liveSize);
    }
  }

  const { price, crossed } = await futPriceNow();
  const result  = await placeLimitCloseAt(base, token, leg.fut_instrument, toClose, leg.fut_dir, price, true);
  const orderId = result.order?.order_id;
  await _log(comboJobId,
    leg.fut_sweep
      ? `Leg ${leg.leg_index + 1} futures sweep ${crossed ? "CROSSING" : "maker"} close placed: ${toClose}x ${leg.fut_instrument} @ ${price} [order ${orderId}]`
      : `Leg ${leg.leg_index + 1} futures ${crossed ? "CROSSING" : "maker"} close placed: ${toClose}x ${leg.fut_instrument} @ ${price} (structure ${Math.round(filledRatio * 100)}% closed, hedge ${alreadyClosed}/${desiredTotal}) [order ${orderId}]`
  );
  // Only PLACED here. fut_closed_qty is credited when it actually fills, and
  // fut_done is decided by the obligation check above — a market order could
  // assume completion, a resting maker cannot.
  await pool.query(`UPDATE auto_close_combo_legs SET fut_order_id=? WHERE id=?`, [orderId, leg.id]);
  if (crossed && leg.fut_cross_price == null) {
    await pool.query(`UPDATE auto_close_combo_legs SET fut_cross_price=? WHERE id=?`, [price, leg.id]);
  }
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

    const col = await collateral(job.account_id, job.token).catch(() => null);
    // Same basis as the trigger check in _processComboJob — Net PnL must be
    // measured against the same number that decided to close.
    const isCoinMargined = col ? col.coin_symbol !== "USDC" : job.initial_usdc_equity_usd == null;
    const useCoinOnly = isCoinMargined && job.monitor_mode !== "combined";
    const finalEquity = col
      ? (useCoinOnly ? col.coin_equity_usd : col.total_usd)
      : parseFloat(job.last_equity_usd ?? job.initial_total_usd);
    await pool.query(`UPDATE auto_close_combo_jobs SET final_equity_usd=? WHERE id=?`, [finalEquity, comboJobId]);

    const initial     = parseFloat(job.initial_total_usd);
    const initialUsdc = job.initial_usdc_equity_usd != null ? parseFloat(job.initial_usdc_equity_usd) : null;
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
      useCoinOnly
        ? `Initial ${col?.coin_symbol ?? ""} collateral: $${initial.toFixed(2)}${initialUsdc != null ? ` (USDC $${initialUsdc.toFixed(2)}, reference only)` : ""}`
        : `Initial collateral: $${initial.toFixed(2)}`,
      useCoinOnly
        ? `Final ${col?.coin_symbol ?? ""} collateral: $${finalEquity.toFixed(2)}${col ? ` (USDC $${col.usdc_equity.toFixed(2)}, reference only)` : ""}`
        : `Final collateral: $${finalEquity.toFixed(2)}`,
      `<b>Net PnL: ${netDiff >= 0 ? "+" : ""}$${netDiff.toFixed(2)}</b>`,
    ];

    await sendTelegramAlert(lines.join("\n"));
  } catch (e) {
    console.error(`[auto-close-combo-worker #${comboJobId}] finish-job alert failed:`, e.message);
  }
}

import { NextResponse } from "next/server";
import pool from "../../../lib/options-db.js";
import { collateral, normalizeToken } from "../../../lib/deribit-close-helpers.js";
import { fetchLivePositions, baseCoin } from "../../../lib/deribit-positions.js";
import { ensureComboTables, startComboWorker } from "../../../lib/auto-close-combo-worker.js";

export const dynamic = "force-dynamic";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// Deribit does not zero-pad single-digit expiry days (BTC-1AUG26-…, never
// BTC-01AUG26-…), so a saved strategy row is matched to its live position by
// rebuilding the name that way.
function buildOptInst(trade) {
  if (!trade.expiry || !trade.options_strike || !trade.option_type) return null;
  const d = new Date(String(trade.expiry).slice(0, 10) + "T00:00:00Z");
  if (isNaN(d)) return null;
  const coin = normalizeToken(trade.token);
  return `${coin}-${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}-${trade.options_strike}-${trade.option_type === "CALL" ? "C" : "P"}`;
}

// POST { account_id, token }
//   → { combo_job_id, legs, message }
//
// Creates a SERVER-SIDE close job rather than firing orders inline. The
// previous implementation placed every order in one request and returned:
// options as a single un-chased limit and futures at market, all
// simultaneously. That had two problems worth spelling out, because both
// could leave a position in a worse state than not exiting at all:
//
//   1. The futures market order filled instantly while the option's limit sat
//      resting. A partial (or zero) option fill therefore left the option
//      exposure standing with its hedge already gone.
//   2. Nothing followed up. An unfilled limit rested on the book forever and
//      the UI reported "Order placed" as if that were an exit.
//
// Handing the work to the combo worker fixes both: it chases the mark with
// repeated maker re-quotes, lifts each leg's hedge in proportion to how much
// of that leg's option has actually filled, and survives the tab closing.
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { account_id, token, cross_after_secs = null } = body;
  // Null/blank means "stay maker forever" — the original behavior. A number
  // is the seconds a leg may rest unfilled before crossing the spread.
  const crossAfter = cross_after_secs === "" || cross_after_secs == null
    ? null
    : Math.max(0, Math.round(Number(cross_after_secs))) || null;
  if (!account_id || !token) {
    return NextResponse.json({ error: "account_id and token are required" }, { status: 400 });
  }

  try {
    await ensureComboTables();
    startComboWorker();

    // Refuse to stack a second closing job on the same account+token — two
    // jobs would each size their orders against the same live position and
    // race to close it twice.
    const [[existing]] = await pool.query(
      `SELECT id FROM auto_close_combo_jobs
        WHERE account_id=? AND token=? AND status IN ('active','closing') LIMIT 1`,
      [account_id, token]
    );
    if (existing) {
      return NextResponse.json(
        { error: `Job #${existing.id} is already running for this coin. Stop it before starting a manual exit.`, existing_job_id: existing.id },
        { status: 409 }
      );
    }

    // Read positions server-side rather than trusting the browser's copy,
    // which was fetched before the user read the dialog and may be stale by
    // the time Confirm is pressed.
    const { positions, badIp } = await fetchLivePositions(account_id, token);

    // Refuse outright on bad_ip, even if SOME positions came back. Positions
    // are read per margin-currency, so a rejection on one currency while
    // another succeeds yields a partial list that looks complete. Building a
    // close job on that would close the option legs it can see while their
    // hedge — sitting in the currency that failed — stays invisible and
    // untouched, turning "exit everything" into "go naked". Refusing is the
    // only safe response to knowingly incomplete position data.
    if (badIp) {
      return NextResponse.json(
        { error: "Deribit rejected part of this request as bad_ip, so the position list may be incomplete. Refusing to start a close that could leave a hedge open. Fix the account's IP allowlist and retry." },
        { status: 400 }
      );
    }
    if (!positions.length) {
      return NextResponse.json(
        { error: "No open positions found for this coin on this account." },
        { status: 400 }
      );
    }

    const optionPositions  = positions.filter(p => p.kind === "option");
    const futuresPositions = positions.filter(p => p.kind === "future");

    // Saved rows supply each leg's intended hedge size (fut_qty) — the ratio
    // basis the hedge is unwound against.
    const [trades] = await pool.query(
      `SELECT * FROM options_trades WHERE status='open' AND account_id=? AND UPPER(token)=UPPER(?)`,
      [account_id, token]
    );
    const tradeByInst = {};
    for (const t of trades) {
      const inst = buildOptInst(t);
      if (inst) tradeByInst[inst] = t;
    }

    const coin = baseCoin(token);
    const futInstFor = (trade) => {
      const preferred = trade?.fut_instrument_type === "linear"
        ? `${coin}_USDC-PERPETUAL`
        : `${coin}-PERPETUAL`;
      if (futuresPositions.some(f => f.instrument_name === preferred)) return preferred;
      // Saved type disagrees with what's actually open (or isn't set) — fall
      // back only when there's exactly one futures position, so a guess can
      // never attach a leg to the wrong instrument.
      return futuresPositions.length === 1 ? futuresPositions[0].instrument_name : "";
    };
    const futDirFor = (instName) => {
      const f = futuresPositions.find(p => p.instrument_name === instName);
      return f ? (f.direction === "buy" ? "sell" : "buy") : "sell";
    };

    // Every option leg works at once (all phase 0); only the leftover-futures
    // sweep waits (phase 1).
    //
    // The earlier design closed shorts before longs so a spread could never be
    // left half-unwound as a naked short. In practice that made the whole exit
    // hostage to the slowest short: options close as makers and never cross
    // the spread, so an illiquid short leg held every other leg at a standstill
    // indefinitely. Placing them together gets the position flat far sooner,
    // at the cost of a window where the longs may fill first and briefly leave
    // the remaining shorts uncovered. Chosen deliberately — see the sweep
    // below, which still runs last so the hedge is never lifted early.
    const legs = [];
    const ordered = [
      ...optionPositions.filter(p => p.direction === "sell"),
      ...optionPositions.filter(p => p.direction !== "sell"),
    ];
    for (const p of ordered) {
      const trade    = tradeByInst[p.instrument_name] || null;
      const futQty   = trade?.fut_qty != null ? Math.abs(parseFloat(trade.fut_qty)) : 0;
      const futInst  = futQty > 0 ? futInstFor(trade) : "";
      const size     = Math.abs(p.size);
      legs.push({
        leg_index:      legs.length,
        leg_type:       trade ? `${trade.option_type} ${trade.options_strike}` : p.instrument_name,
        close_phase:    0,   // every option leg works simultaneously
        opt_instrument: p.instrument_name,
        opt_qty:        size,
        opt_start_qty:  size,                                   // ratio basis, from LIVE size
        opt_dir:        p.direction === "buy" ? "sell" : "buy", // close direction
        opt_entry_price: trade?.opt_entry_price ?? null,
        fut_instrument: futInst,
        fut_qty:        futInst ? futQty : 0,
        fut_dir:        futInst ? futDirFor(futInst) : "sell",
        fut_entry_price: trade?.fut_entry_price ?? null,
        fut_sweep:      0,
      });
    }

    // One sweep leg per live futures instrument, so anything the
    // proportional legs don't claim still gets closed and "Exit All" ends
    // genuinely flat. Harmless when they do claim it all: the sweep finds
    // the position already flat and marks itself done.
    for (const f of futuresPositions) {
      legs.push({
        leg_index:      legs.length,
        leg_type:       "futures sweep",
        close_phase:    1,   // sweep still runs after all option legs
        opt_instrument: "",
        opt_qty:        0,
        opt_start_qty:  null,
        opt_dir:        "sell",
        opt_entry_price: null,
        fut_instrument: f.instrument_name,
        fut_qty:        0,
        fut_dir:        f.direction === "buy" ? "sell" : "buy",
        fut_entry_price: null,
        fut_sweep:      1,
      });
    }

    const col = await collateral(account_id, token).catch(() => null);
    const initialTotalUsd = col ? col.total_usd : 0;

    // target_pnl/target_total_usd are NOT NULL on the shared table but carry
    // no meaning for a manual exit — it starts in 'closing' and never
    // consults them.
    const [result] = await pool.query(
      `INSERT INTO auto_close_combo_jobs
         (group_id, account_id, token, initial_total_usd, target_pnl, target_total_usd,
          status, job_kind, cross_after_secs, triggered_at)
       VALUES (?,?,?,?,0,0,'closing','manual',?,NOW())`,
      [`manual_exit_${Date.now()}`, account_id, token, initialTotalUsd, crossAfter]
    );
    const jobId = result.insertId;

    await pool.query(
      `INSERT INTO auto_close_combo_legs
         (combo_job_id, leg_index, leg_type, close_phase,
          opt_instrument, opt_qty, opt_start_qty, opt_dir, opt_entry_price,
          fut_instrument, fut_qty, fut_dir, fut_entry_price, fut_sweep)
       VALUES ?`,
      [legs.map(l => [
        jobId, l.leg_index, l.leg_type, l.close_phase,
        l.opt_instrument, l.opt_qty, l.opt_start_qty, l.opt_dir, l.opt_entry_price,
        l.fut_instrument, l.fut_qty, l.fut_dir, l.fut_entry_price, l.fut_sweep,
      ])]
    );

    // Any target-based job still watching this account+token would otherwise
    // keep polling a position this job is actively closing.
    await pool.query(
      `UPDATE auto_close_jobs SET status='stopped', completed_at=NOW()
        WHERE account_id=? AND token=? AND status IN ('active','closing_option','closing_futures')`,
      [account_id, token]
    ).catch(() => {});

    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    await pool.query(
      `UPDATE auto_close_combo_jobs SET log_json=JSON_ARRAY_APPEND(COALESCE(log_json,'[]'),'$',?) WHERE id=?`,
      [`[${ts}] Manual exit started — ${optionPositions.length} option leg(s), ${futuresPositions.length} futures instrument(s). All option legs close together; leftover futures sweep last.${crossAfter != null ? ` Crossing the spread on any leg still unfilled after ${crossAfter}s.` : " Maker only — never crossing the spread."}`, jobId]
    ).catch(() => {});

    return NextResponse.json({
      combo_job_id: jobId,
      legs: legs.length,
      option_legs: optionPositions.length,
      message: "Close job started. Options are chased with maker re-quotes; each hedge is lifted in proportion to its option's fill.",
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

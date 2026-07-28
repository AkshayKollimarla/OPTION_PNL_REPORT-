import { NextResponse } from "next/server";
import pool from "@/lib/options-db.js";

export const dynamic = "force-dynamic";

// GET /api/monitor-list
// One place to see every auto-close job (single-leg + combo) across the
// whole app — active/closing ones to watch live, plus failed ones that
// need a manual resume (e.g. after a Deribit outage or IP-whitelist block).
export async function GET() {
  try {
    const [singleJobsRaw] = await pool.query(`
      SELECT j.id, j.account_id, j.token, j.opt_instrument, j.status,
             j.target_pnl, j.target_total_usd, j.initial_total_usd, j.last_equity_usd,
             j.opt_close_price, j.fut_close_price, j.final_equity_usd,
             j.error_msg, j.created_at, j.completed_at,
             t.id AS trade_id, t.options_strike, t.option_type, t.expiry
      FROM auto_close_jobs j
      LEFT JOIN options_trades t ON t.id = j.trade_id
      WHERE j.status IN ('active','closing_option','closing_futures','failed','completed','stopped')
      ORDER BY j.id DESC
      LIMIT 200
    `);
    // Using the JOINED t.id (not the job's raw j.trade_id foreign key) as
    // trade_id above — if the trade row was since deleted (the user cleaning
    // up Options Dashboard after manually closing a position, most
    // commonly), t.id comes back NULL here, and the frontend's existing
    // null-safe fallback kicks in instead of linking to a 404.

    // Same retry pattern as combo jobs below can leave more than one job row
    // behind for the same trade_id — keep only the most recent per trade_id.
    // A null trade_id (deleted trade) is never a shared dedup key — multiple
    // unrelated jobs can each have their trade deleted independently, and
    // treating null==null here would incorrectly collapse them into one.
    const seenTrades = new Set();
    const singleJobs = singleJobsRaw
      .filter((j) => {
        if (j.trade_id == null) return true;
        if (seenTrades.has(j.trade_id)) return false;
        seenTrades.add(j.trade_id);
        return true;
      })
      .sort((a, b) => (a.status === "failed") - (b.status === "failed") || b.id - a.id);

    const [comboJobsRaw] = await pool.query(`
      SELECT id, group_id, account_id, token, status, target_pnl, target_total_usd,
             initial_total_usd, last_equity_usd, final_equity_usd, error_msg, created_at, completed_at
      FROM auto_close_combo_jobs
      WHERE status IN ('active','closing','failed','completed','stopped')
      ORDER BY id DESC
      LIMIT 200
    `);

    // Each retry (Execute + Auto-Close / Start Monitor Only) inserts a fresh
    // job row rather than reusing one, so a group_id that's been retried a
    // few times ends up with several stale job rows behind the current one.
    // Keep only the most recent row per group_id — already sorted id DESC,
    // so the first one seen per group is the one that matters.
    const seenGroups = new Set();
    const comboJobs = comboJobsRaw
      .filter((c) => {
        if (seenGroups.has(c.group_id)) return false;
        seenGroups.add(c.group_id);
        return true;
      })
      .sort((a, b) => (a.status === "failed") - (b.status === "failed") || b.id - a.id);

    // Each combo job needs a representative trade_id to link into the
    // existing single-trade Monitor page (which derives the combo panel
    // from trade.group_id), plus its legs for a quick summary.
    for (const c of comboJobs) {
      const [[repTrade]] = await pool.query(
        `SELECT id FROM options_trades WHERE group_id = ? ORDER BY id LIMIT 1`,
        [c.group_id]
      );
      c.trade_id = repTrade?.id ?? null;

      const [legs] = await pool.query(
        `SELECT leg_index, leg_type, opt_instrument, opt_done, fut_done FROM auto_close_combo_legs WHERE combo_job_id = ? ORDER BY leg_index`,
        [c.id]
      );
      c.legs = legs;
    }

    return NextResponse.json({ singleJobs, comboJobs });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

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
      SELECT j.id, j.trade_id, j.account_id, j.token, j.opt_instrument, j.status,
             j.target_pnl, j.target_total_usd, j.initial_total_usd, j.last_equity_usd,
             j.error_msg, j.created_at, j.completed_at,
             t.options_strike, t.option_type, t.expiry
      FROM auto_close_jobs j
      LEFT JOIN options_trades t ON t.id = j.trade_id
      WHERE j.status IN ('active','closing_option','closing_futures','failed')
      ORDER BY j.id DESC
    `);

    // Same retry pattern as combo jobs below can leave more than one job row
    // behind for the same trade_id — keep only the most recent per trade_id.
    const seenTrades = new Set();
    const singleJobs = singleJobsRaw
      .filter((j) => {
        if (seenTrades.has(j.trade_id)) return false;
        seenTrades.add(j.trade_id);
        return true;
      })
      .sort((a, b) => (a.status === "failed") - (b.status === "failed") || b.id - a.id);

    const [comboJobsRaw] = await pool.query(`
      SELECT id, group_id, account_id, token, status, target_pnl, target_total_usd,
             initial_total_usd, last_equity_usd, error_msg, created_at, completed_at
      FROM auto_close_combo_jobs
      WHERE status IN ('active','closing','failed')
      ORDER BY id DESC
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

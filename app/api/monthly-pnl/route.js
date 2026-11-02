import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";
import { buildMonths } from "../../../lib/monthly-pnl";

export const dynamic = "force-dynamic";

/**
 * The closed book, month by month.
 *
 * One line per structure rather than per leg: a four-leg combination was one
 * trade and was logged as one line by hand, so the legs are summed back into
 * it here. Single-leg strategies have no group_id and stand as their own line.
 *
 * The figures are the ones recorded when the structure was closed -- not
 * recomputed from entry and exit prices. What was written down at the close is
 * what the log should report, including when someone corrected it by hand.
 */
export async function GET() {
  try {
    const [rows] = await pool.query(`
      SELECT COALESCE(t.group_id, CONCAT('#', t.id))          AS \`key\`,
             MIN(t.token)                                      AS token,
             MIN(a.name)                                       AS account,
             DATE_FORMAT(MAX(t.end_date), '%Y-%m-%d')          AS ended,
             SUM(COALESCE(t.opt_pnl, 0))                       AS opt_pnl,
             SUM(COALESCE(t.fut_pnl, 0))                       AS fut_pnl,
             SUM(COALESCE(t.net_booked_pnl, 0))                AS net_booked_pnl,
             COUNT(*)                                          AS legs
        FROM options_trades t
        LEFT JOIN trading_accounts a ON a.id = t.account_id
       WHERE t.status = 'closed'
       GROUP BY \`key\`
       ORDER BY ended DESC`);

    return NextResponse.json(buildMonths(rows));
  } catch (err) {
    return NextResponse.json({ error: err.message, months: [], undated: [] }, { status: 200 });
  }
}

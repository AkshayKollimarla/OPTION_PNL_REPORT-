import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

// Local YYYY-MM-DD from a JS Date (avoids UTC shift on toISOString)
function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo   = searchParams.get("date_to")   || "";
  const account  = searchParams.get("account")   || "";

  try {
    // Always return all accounts (not date-restricted)
    const [accountRows] = await pool.query(
      `SELECT DISTINCT token_name, MAX(token_symbol) AS token_symbol
       FROM bot_entries
       WHERE token_name IS NOT NULL
       GROUP BY token_name
       ORDER BY token_name`
    );

    if (!dateFrom || !dateTo) {
      return NextResponse.json({ accounts: accountRows, summary: null, dates: [], dayBreakdown: [] });
    }

    const conditions = [
      "DATE(entry_datetime) >= ?",
      "DATE(entry_datetime) <= ?",
    ];
    const params = [dateFrom, dateTo];

    if (account && account !== "all") {
      conditions.push("token_name = ?");
      params.push(account);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    // Overall summary
    const [rows] = await pool.query(`
      SELECT
        COUNT(*)                                AS entry_count,
        AVG(COALESCE(rtps, 0))                 AS rtps,
        AVG(COALESCE(per_hour_rtps, 0))        AS per_hour_rtps,
        SUM(COALESCE(rebates, 0))              AS rebates,
        SUM(COALESCE(flatten_pnl, 0))          AS flatten_pnl,
        SUM(COALESCE(gamma_booked, 0))         AS gamma_booked,
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(gamma_booked, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
        SUM(COALESCE(rtp_pnl, 0))              AS rtp_pnl,
        SUM(COALESCE(volume, 0))               AS volume,
        SUM(COALESCE(investment, 0))           AS total_investment,
        COUNT(DISTINCT DATE(entry_datetime))   AS active_days
      FROM bot_entries
      ${where}
    `, params);

    const s = rows[0];
    const apy = s.total_investment
      ? (Number(s.net_pnl) / Number(s.total_investment)) * 365 * 100
      : null;

    // Per-day breakdown
    const [dayRows] = await pool.query(`
      SELECT
        DATE(entry_datetime)                   AS date,
        COUNT(*)                               AS entry_count,
        AVG(COALESCE(rtps, 0))                AS rtps,
        AVG(COALESCE(per_hour_rtps, 0))       AS per_hour_rtps,
        SUM(COALESCE(rebates, 0))             AS rebates,
        SUM(COALESCE(flatten_pnl, 0))         AS flatten_pnl,
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(gamma_booked, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
        SUM(COALESCE(rtp_pnl, 0))             AS rtp_pnl,
        SUM(COALESCE(volume, 0))              AS volume
      FROM bot_entries
      ${where}
      GROUP BY DATE(entry_datetime)
      ORDER BY DATE(entry_datetime)
    `, params);

    // Best net_pnl entry (full row — for bot input parameters)
    const [bestPnlRows] = await pool.query(
      `SELECT * FROM bot_entries ${where} ORDER BY net_pnl DESC LIMIT 1`, params
    );

    // Best rtps entry (full row)
    const [bestRtpsRows] = await pool.query(
      `SELECT * FROM bot_entries ${where} ORDER BY rtps DESC LIMIT 1`, params
    );

    // Build date list using local-date arithmetic (no UTC shift)
    const dates = [];
    const start = new Date(dateFrom + "T00:00:00");
    const end   = new Date(dateTo   + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(localDate(d));
    }

    return NextResponse.json({
      accounts:     accountRows,
      summary:      { ...s, apy },
      dates,
      runningDays:  dates.length,
      dayBreakdown: dayRows,
      bestPnlEntry:  bestPnlRows[0]  ? recomputeNetPnl(bestPnlRows[0])  : null,
      bestRtpsEntry: bestRtpsRows[0] ? recomputeNetPnl(bestRtpsRows[0]) : null,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function recomputeNetPnl(row) {
  const n = (v) => Number(v) || 0;
  return { ...row, net_pnl: n(row.rtp_pnl) + n(row.gamma_booked) + n(row.rebates) };
}

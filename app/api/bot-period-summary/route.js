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
      // Accounts come from `account`; token_name is the instrument on
       // Hyperliquid rows and would split one account into several.
       `SELECT account AS token_name, MAX(token_symbol) AS token_symbol
       FROM bot_entries
       WHERE account IS NOT NULL AND account != ''
       GROUP BY account
       ORDER BY account`
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
      conditions.push("account = ?");
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
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
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
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
        SUM(COALESCE(rtp_pnl, 0))             AS rtp_pnl,
        SUM(COALESCE(volume, 0))              AS volume
      FROM bot_entries
      ${where}
      GROUP BY DATE(entry_datetime)
      ORDER BY DATE(entry_datetime)
    `, params);

    // The most recent entry in the window, as the source of the bot's
    // configuration sheet. Its parameters are the settings the bot was last
    // running under — which is what the sheet is for. Singling out a
    // best-performing day instead described one lucky session, not the setup.
    const [latestRows] = await pool.query(
      `SELECT * FROM bot_entries ${where} ORDER BY entry_datetime DESC, id DESC LIMIT 1`, params
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
      latestEntry:   latestRows[0]   ? recomputeNetPnl(latestRows[0])   : null,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function recomputeNetPnl(row) {
  const n = (v) => Number(v) || 0;
  return { ...row, net_pnl: n(row.rtp_pnl) + n(row.rebates) };
}

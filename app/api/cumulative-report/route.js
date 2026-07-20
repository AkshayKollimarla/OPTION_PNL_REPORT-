import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo   = searchParams.get("date_to")   || "";
  const account  = (searchParams.get("account")  || "").trim();
  const symbol   = (searchParams.get("symbol")   || "").trim();

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ error: "date_from and date_to are required." }, { status: 400 });
  }

  const conditions = [
    "DATE(entry_datetime) >= ?",
    "DATE(entry_datetime) <= ?",
  ];
  const params = [dateFrom, dateTo];

  if (account) {
    // Exact account match — symbol filter is redundant when account is set
    conditions.push("token_name = ?");
    params.push(account);
  } else if (symbol) {
    // No account specified: match all accounts whose name starts with the symbol
    // e.g. "ETH" matches "ETH-HIDDEN", "ETH-HFT1", etc.
    conditions.push("token_name LIKE ?");
    params.push(`${symbol}%`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  try {
    const [rows] = await pool.query(`
      SELECT
        token_name,
        MAX(token_symbol)                        AS token_symbol,
        SUM(COALESCE(rtps, 0))                   AS rtps,
        AVG(COALESCE(per_hour_rtps, 0))          AS per_hour_rtps,
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
        SUM(COALESCE(rtp_pnl, 0))                AS rtp_pnl,
        SUM(COALESCE(rebates, 0))                AS rebates,
        SUM(COALESCE(flatten_pnl, 0))            AS flatten_pnl,
        SUM(COALESCE(gamma_booked, 0))           AS gamma_booked,
        SUM(COALESCE(volume, 0))                 AS volume,
        COUNT(*)                                 AS entry_count,
        COUNT(DISTINCT DATE(entry_datetime))     AS active_days
      FROM bot_entries
      ${where}
      GROUP BY token_name
      ORDER BY net_pnl DESC
    `, params);

    const totals = rows.reduce(
      (acc, r) => {
        acc.net_pnl     += Number(r.net_pnl      || 0);
        acc.rtp_pnl     += Number(r.rtp_pnl      || 0);
        acc.rebates     += Number(r.rebates       || 0);
        acc.flatten_pnl += Number(r.flatten_pnl   || 0);
        acc.gamma_booked+= Number(r.gamma_booked  || 0);
        acc.volume      += Number(r.volume        || 0);
        return acc;
      },
      { net_pnl: 0, rtp_pnl: 0, rebates: 0, flatten_pnl: 0, gamma_booked: 0, volume: 0 }
    );

    return NextResponse.json({ rows, totals });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

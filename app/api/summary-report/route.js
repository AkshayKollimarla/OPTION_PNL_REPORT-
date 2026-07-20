import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date   = searchParams.get("date");
  const symbol = searchParams.get("symbol");

  const where  = [];
  const params = [];

  if (date) {
    where.push("DATE(entry_datetime) = ?");
    params.push(date);
  }
  if (symbol && symbol !== "all") {
    where.push("token_symbol = ?");
    params.push(symbol);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await pool.query(`
      SELECT
        token_symbol,
        token_name,
        COUNT(*) AS entry_count,
        AVG(COALESCE(rtps, 0))          AS rtps,
        AVG(COALESCE(per_hour_rtps, 0)) AS per_hour_rtps,
        SUM(COALESCE(rebates, 0))       AS rebates,
        SUM(COALESCE(flatten_pnl, 0))   AS flatten_pnl,
        SUM(COALESCE(gamma_booked, 0))  AS gamma_booked,
        SUM(COALESCE(rtp_pnl, 0)) + SUM(COALESCE(rebates, 0)) AS net_pnl,
        SUM(COALESCE(volume, 0))        AS volume,
        SUM(COALESCE(investment, 0))    AS total_investment,
        SUM(COALESCE(rtp_pnl, 0))       AS rtp_pnl
      FROM bot_entries
      ${whereClause}
      GROUP BY token_symbol, token_name
      ORDER BY net_pnl DESC
    `, params);

    const tokens = rows.map((r) => ({
      ...r,
      apy: r.total_investment
        ? (Number(r.net_pnl) / Number(r.total_investment)) * 365 * 100
        : null,
    }));

    const totalNetPnl = tokens.reduce((s, t) => s + Number(t.net_pnl || 0), 0);

    const [symRows] = await pool.query(
      "SELECT DISTINCT token_symbol FROM bot_entries WHERE token_symbol IS NOT NULL ORDER BY token_symbol"
    );
    const symbols = symRows.map((r) => r.token_symbol);

    return NextResponse.json({ tokens, totalNetPnl, symbols });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

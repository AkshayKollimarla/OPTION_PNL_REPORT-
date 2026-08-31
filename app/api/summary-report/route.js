import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date     = searchParams.get("date");
  const symbol   = searchParams.get("symbol");
  const exchange = searchParams.get("exchange");

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
  if (exchange && exchange !== "all") {
    where.push("exchange = ?");
    params.push(exchange);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await pool.query(`
      SELECT
        token_symbol,
        account AS token_name,
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
      GROUP BY token_symbol, account
      ORDER BY net_pnl DESC
    `, params);

    const tokens = rows.map((r) => ({
      ...r,
      apy: r.total_investment
        ? (Number(r.net_pnl) / Number(r.total_investment)) * 365 * 100
        : null,
    }));

    const totalNetPnl = tokens.reduce((s, t) => s + Number(t.net_pnl || 0), 0);

    // Deliberately unfiltered: the dropdowns list every option that exists,
    // not just the ones surviving the current filter, so a filter can always
    // be widened again rather than trapping the user in an empty result.
    const [symRows] = await pool.query(
      "SELECT DISTINCT token_symbol, exchange FROM bot_entries WHERE token_symbol IS NOT NULL AND token_symbol != '' ORDER BY exchange, token_symbol"
    );
    const [exRows] = await pool.query(
      "SELECT DISTINCT exchange FROM bot_entries WHERE exchange IS NOT NULL AND exchange != '' ORDER BY exchange"
    );
    const symbols = symRows.map((r) => r.token_symbol);

    return NextResponse.json({
      tokens,
      totalNetPnl,
      symbols,
      exchanges: exRows.map((r) => r.exchange),
      // symbol -> exchange, so the Symbol dropdown can narrow to the chosen
      // exchange without a second round trip
      symbolExchange: Object.fromEntries(symRows.map((r) => [r.token_symbol, r.exchange])),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

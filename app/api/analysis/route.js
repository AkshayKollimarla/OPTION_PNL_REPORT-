import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol  = searchParams.get("symbol");
  const account = searchParams.get("account");
  const from    = searchParams.get("from");
  const to      = searchParams.get("to");

  const where = [];
  const params = [];
  if (symbol)  { where.push("token_symbol = ?"); params.push(symbol); }
  if (account) { where.push("token_name = ?");    params.push(account); }
  if (from)    { where.push("entry_datetime >= ?"); params.push(`${from} 00:00:00`); }
  if (to)      { where.push("entry_datetime <= ?"); params.push(`${to} 23:59:59`); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    // Overall stats
    const [[stats]] = await pool.query(
      `SELECT
         COUNT(*)        AS total_entries,
         MAX(rtps)       AS max_rtps,
         MIN(rtps)       AS min_rtps,
         AVG(rtps)       AS avg_rtps,
         MAX(rtp_pnl + gamma_booked + rebates)    AS max_net_pnl,
         MIN(rtp_pnl + gamma_booked + rebates)    AS min_net_pnl,
         SUM(rtp_pnl + gamma_booked + rebates)    AS total_net_pnl,
         MAX(apy)        AS max_apy,
         MIN(apy)        AS min_apy,
         AVG(apy)        AS avg_apy,
         SUM(rtp_pnl)    AS total_rtp_pnl,
         SUM(volume)     AS total_volume
       FROM bot_entries ${W}`,
      params
    );

    // Best RTPS entry (full row)
    const [[bestRtps]] = await pool.query(
      `SELECT * FROM bot_entries ${W} ORDER BY rtps DESC LIMIT 1`,
      params
    );

    // Worst RTPS entry (full row)
    const [[worstRtps]] = await pool.query(
      `SELECT * FROM bot_entries ${W} ORDER BY rtps ASC LIMIT 1`,
      params
    );

    // Best Net-PNL entry
    const [[bestPnl]] = await pool.query(
      `SELECT * FROM bot_entries ${W} ORDER BY net_pnl DESC LIMIT 1`,
      params
    );

    // Worst Net-PNL entry
    const [[worstPnl]] = await pool.query(
      `SELECT * FROM bot_entries ${W} ORDER BY net_pnl ASC LIMIT 1`,
      params
    );

    // Best APY entry
    const [[bestApy]] = await pool.query(
      `SELECT * FROM bot_entries ${W} ORDER BY apy DESC LIMIT 1`,
      params
    );

    // Distinct symbols + accounts for filters
    const [symbolRows]  = await pool.query(`SELECT DISTINCT token_symbol FROM bot_entries WHERE token_symbol IS NOT NULL AND token_symbol != '' ORDER BY token_symbol`);
    const [accountRows] = await pool.query(`SELECT DISTINCT token_name FROM bot_entries WHERE token_name IS NOT NULL AND token_name != '' ORDER BY token_name`);

    return NextResponse.json({
      stats,
      bestRtps:  bestRtps  ? recomputeNetPnl(bestRtps)  : null,
      worstRtps: worstRtps ? recomputeNetPnl(worstRtps) : null,
      bestPnl:   bestPnl   ? recomputeNetPnl(bestPnl)   : null,
      worstPnl:  worstPnl  ? recomputeNetPnl(worstPnl)  : null,
      bestApy:   bestApy   ? recomputeNetPnl(bestApy)   : null,
      symbols:   symbolRows.map((r) => r.token_symbol),
      accounts:  accountRows.map((r) => r.token_name),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function recomputeNetPnl(row) {
  const n = (v) => Number(v) || 0;
  return { ...row, net_pnl: n(row.rtp_pnl) + n(row.gamma_booked) + n(row.rebates) };
}

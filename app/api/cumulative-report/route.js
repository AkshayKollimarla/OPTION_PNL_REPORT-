import { NextResponse } from "next/server";
import pool from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo   = searchParams.get("date_to")   || "";
  const account  = (searchParams.get("account")  || "").trim();
  const symbol   = (searchParams.get("symbol")   || "").trim();

  // No range means the whole history. Requiring both dates made the report
  // unreachable until two pickers were filled in, even when the wanted answer
  // was simply "everything".
  const conditions = [];
  const params = [];
  if (dateFrom) { conditions.push("DATE(entry_datetime) >= ?"); params.push(dateFrom); }
  if (dateTo)   { conditions.push("DATE(entry_datetime) <= ?"); params.push(dateTo); }

  // Account and symbol are INDEPENDENT filters, applied together.
  //
  // They used to be either/or, on the assumption that an account traded one
  // symbol so naming the account already pinned it. That stopped being true:
  // HYPER-USMARKETS alone carries CRCL, HIMS, HOOD, HYPE-USDC and PLTR, so
  // selecting a symbol did nothing once an account was chosen and the report
  // silently returned the account's whole book.
  if (account) {
    conditions.push("account = ?");
    params.push(account);
  }
  if (symbol) {
    // Prefix match so a base symbol still catches its suffixed instrument
    // (HYPE matches HYPE-USDC), which the plain symbol list does not carry.
    conditions.push("token_symbol LIKE ?");
    params.push(`${symbol}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const [rows] = await pool.query(`
      SELECT
        account AS token_name,
        -- Every symbol in the group, not an arbitrary one. MAX() returned
        -- whichever sorted last (PLTR for an account also holding CRCL),
        -- labelling the row with a symbol whose numbers it did not represent.
        GROUP_CONCAT(DISTINCT token_symbol ORDER BY token_symbol SEPARATOR ', ') AS token_symbol,
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
      GROUP BY account
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

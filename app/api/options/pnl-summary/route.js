import { NextResponse } from "next/server";
import optionsPool from "../../../../lib/options-db";

export const dynamic = "force-dynamic";

// GET /api/options/pnl-summary?from=&to=&exchange=&base=&account=
//   → { bookedPnl, closedCount, openCount, totalCount }
//
// Aggregated in SQL rather than by summing a page of rows in the browser:
// the trades endpoint paginates, so a client-side total would quietly cover
// only the current page and read as if it were the whole book.
//
// Only closed strategies contribute. Open ones carry net_booked_pnl = 0 by
// definition — nothing is booked until the position is closed — so including
// them would not change the number, but counting them separately makes it
// clear how much of the book is still running.
//
// Market-making PL is deducted. net_booked_pnl is entered as futures +
// options + market-making, and the market-making leg is the grid bot's own
// contribution, already counted in the bot metrics this card sits beside;
// leaving it in reported it twice.
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const exchange = (sp.get("exchange") || "").trim();
  const account = (sp.get("account") || "").trim();
  // Base token, already normalised by the caller: BTC-PERPETUAL → BTC.
  const base = (sp.get("base") || "").trim();

  const where = [];
  const params = [];
  if (from) {
    where.push("entry_date >= ?");
    params.push(from);
  }
  if (to) {
    where.push("entry_date <= ?");
    params.push(to);
  }
  if (base) {
    // Underscores fold to dashes so SOL_USDC reduces to the same base as
    // SOL-HFT1-…, matching how the rest of the app treats the pair.
    where.push("SUBSTRING_INDEX(REPLACE(token, '_', '-'), '-', 1) = ?");
    params.push(base);
  }
  if (account === "none") {
    // The caller asked for an account that has no options counterpart. Say so
    // with an empty result rather than silently reporting the whole book,
    // which would look like the filter had been ignored.
    where.push("1 = 0");
  } else if (account) {
    where.push("account_id = ?");
    params.push(account);
  }
  if (exchange) {
    // The linked account is authoritative for venue; the token is only a
    // fallback for rows that predate account linking.
    where.push(
      `(account_id IN (SELECT id FROM trading_accounts WHERE UPPER(exchange) = ?)
        OR (account_id IS NULL AND SUBSTRING_INDEX(REPLACE(token, '_', '-'), '-', 1) IN ('BTC','ETH','SOL')
            AND ? = 'DERIBIT'))`
    );
    params.push(exchange.toUpperCase(), exchange.toUpperCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await optionsPool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'closed'
                          THEN COALESCE(net_booked_pnl, 0) - COALESCE(market_making_pl, 0)
                          ELSE 0 END), 0) AS bookedPnl,
         SUM(status = 'closed') AS closedCount,
         SUM(status = 'open')   AS openCount,
         COUNT(*)               AS totalCount
       FROM options_trades ${whereSql}`,
      params
    );
    const r = rows[0] || {};
    return NextResponse.json({
      bookedPnl: Number(r.bookedPnl || 0),
      closedCount: Number(r.closedCount || 0),
      openCount: Number(r.openCount || 0),
      totalCount: Number(r.totalCount || 0),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

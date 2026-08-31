import { NextResponse } from "next/server";
import optionsPool from "../../../../lib/options-db";

export const dynamic = "force-dynamic";

// GET /api/options/pnl-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
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
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

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
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await optionsPool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'closed' THEN COALESCE(net_booked_pnl, 0) ELSE 0 END), 0) AS bookedPnl,
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

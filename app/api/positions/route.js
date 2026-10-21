import { NextResponse } from "next/server";
import { fetchPositions, closePosition } from "../../../lib/positions";

export const dynamic = "force-dynamic";

/** Live positions. ?account=<id> for one, omitted or "all" for every account. */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const account = (searchParams.get("account") || "all").trim();
  try {
    const data = await fetchPositions(account && account !== "all" ? account : null);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Close one position with a resting order.
 *
 * Deliberately narrow: it takes an account and a symbol and nothing else. No
 * size, no price, no side -- those are read from the live position, so a
 * stale page cannot ask for a quantity that is no longer there, and nothing
 * here can open a position or add to one.
 */
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const { accountId, symbol } = body || {};
  if (!accountId || !symbol) {
    return NextResponse.json({ error: "An account and a symbol are required." }, { status: 400 });
  }
  try {
    const result = await closePosition({ accountId, symbol });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

import { NextResponse } from "next/server";
import { fetchLegMids } from "../../../../lib/live-legs";

export const dynamic = "force-dynamic";

/**
 * Live mids for the legs of one structure, in a single call.
 *
 * Read-only and quote-only: it takes contracts and returns prices. The
 * simulator polls this every couple of seconds to show what a position is
 * worth now, so it must be cheap and it must not be able to do anything else.
 */
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const { account_id, legs } = body || {};
  if (!account_id) return NextResponse.json({ error: "An account is required." }, { status: 400 });

  try {
    const { mids, venue } = await fetchLegMids(account_id, legs);
    return NextResponse.json({ mids, venue });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}

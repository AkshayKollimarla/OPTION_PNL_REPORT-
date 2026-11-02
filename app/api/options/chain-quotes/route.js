import { NextResponse } from "next/server";
import { fetchChainQuotes } from "../../../../lib/chain-quotes";

export const dynamic = "force-dynamic";

/**
 * A whole expiry's quotes, for the chain grid.
 *
 * Read-only and quote-only: it takes an account, a token and an expiry, and
 * returns prices. The grid polls it every couple of seconds, so it must stay
 * cheap and it must not be able to do anything else.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("account_id");
  const token = searchParams.get("token");
  const expiry = searchParams.get("expiry");

  try {
    return NextResponse.json(await fetchChainQuotes(accountId, token, expiry));
  } catch (err) {
    // 200 with an error field: the grid shows it beside the rows it still has
    // rather than blanking on a single bad poll.
    return NextResponse.json({ error: err.message, rows: [] }, { status: 200 });
  }
}

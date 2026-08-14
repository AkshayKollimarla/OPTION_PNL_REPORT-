import { NextResponse } from "next/server";
import { fetchLivePositions } from "../../../lib/deribit-positions.js";

export const dynamic = "force-dynamic";

// GET /api/deribit-positions?account_id=X&token=SOL_USDC
//   → { positions: [...], collateral, badIp }
// All of the unit/currency handling lives in lib/deribit-positions.js so the
// exit job is built from exactly the same numbers shown in the confirmation
// dialog.
export async function GET(request) {
  const sp        = new URL(request.url).searchParams;
  const accountId = sp.get("account_id");
  const token     = sp.get("token");
  if (!accountId || !token) {
    return NextResponse.json({ error: "account_id and token required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await fetchLivePositions(accountId, token));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

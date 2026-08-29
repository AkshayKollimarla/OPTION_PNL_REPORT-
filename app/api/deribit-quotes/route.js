import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/deribit-quotes?instruments=A,B,C
//   → { quotes: { [instrument]: { bid, ask, mark, underlying } } }
//
// Deliberately PUBLIC data only. The spread readout refreshes every couple of
// seconds while the exit dialog is open, and polling the authenticated
// positions endpoint at that rate would burn through Deribit's private rate
// limit and re-mint auth tokens — the same single-session-per-key contention
// that produced "unauthorized (code 13009)" elsewhere in this app. Prices are
// public, so none of that is necessary to read them.
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const list = (sp.get("instruments") || "")
    .split(",").map(x => x.trim()).filter(Boolean).slice(0, 12); // cap: this is a poll
  if (!list.length) {
    return NextResponse.json({ error: "instruments required" }, { status: 400 });
  }

  const base = "https://www.deribit.com/api/v2";
  const results = await Promise.allSettled(list.map(async (name) => {
    const r = await fetch(
      `${base}/public/ticker?instrument_name=${encodeURIComponent(name)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    const j = await r.json();
    if (!j.result) throw new Error(j.error?.message || "no result");
    return [name, {
      bid:  j.result.best_bid_price ?? null,
      ask:  j.result.best_ask_price ?? null,
      mark: j.result.mark_price ?? null,
      underlying: j.result.underlying_price ?? j.result.index_price ?? null,
    }];
  }));

  const quotes = {};
  results.forEach((res, i) => {
    if (res.status === "fulfilled") quotes[res.value[0]] = res.value[1];
    // A leg that fails to quote is simply absent — the caller shows it as
    // unknown rather than treating a missing price as zero, which would make
    // a spread look far cheaper than it is.
    else quotes[list[i]] = null;
  });

  return NextResponse.json({ quotes, at: new Date().toISOString() });
}

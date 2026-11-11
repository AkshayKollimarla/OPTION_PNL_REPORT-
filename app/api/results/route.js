import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";
import { fetchResults } from "../../../lib/results-feed";

export const dynamic = "force-dynamic";

/**
 * The Results page: upcoming US earnings, and the Fed and data calendar.
 *
 * Read-only, and entirely from public endpoints -- nothing here needs a
 * broker credential, so the page works whether or not Alpaca and Deribit are
 * reachable.
 */

// Tokens with something open in the book right now.
//
// The page flags these, because an earnings date matters far more when there
// is a position across it: a short call through a print is the one row on a
// six-hundred-row Thursday worth finding. Failing to read them is not a
// failure of the page -- the calendar is still the calendar -- so an error
// here leaves the flags off rather than taking the page down.
async function openTokens() {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT UPPER(token) AS token
         FROM options_trades
        WHERE status = 'open' AND token IS NOT NULL AND token <> ''`
    );
    return rows.map((r) => r.token).filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET(request) {
  try {
    const raw = Number(new URL(request.url).searchParams.get("days"));
    // Bounded: the window is a count of days to ask Nasdaq about, one request
    // each, so an unbounded query string would be a request amplifier.
    const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 30) : 14;

    const [results, held] = await Promise.all([fetchResults({ days }), openTokens()]);
    return NextResponse.json({ ...results, held });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 200 });
  }
}

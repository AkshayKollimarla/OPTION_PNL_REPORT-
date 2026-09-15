import { NextResponse } from "next/server";
import botPool from "../../../lib/db";
import optionsPool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

// GET /api/data-version → { version }
//
// A fingerprint of everything the reports read, so an open page can tell that
// the data under it has changed and reload itself.
//
// It has to be computed from the data rather than announced by whoever wrote
// it. Writes arrive from many places — the entry forms, the combined
// simulator, the options dashboard's delete, the entries log, and the
// server-side auto-close workers that book a strategy closed with no browser
// involved at all. A page listening for "something was saved" events would
// miss every write it was not told about; a checksum of the tables cannot.
//
// CHECKSUM TABLE is a full scan, which is only acceptable because these tables
// are small — a few hundred rows each, answered in well under a millisecond.
// No updated_at column exists on options_trades to do this more cheaply.
async function checksum(pool, table) {
  const [rows] = await pool.query(`CHECKSUM TABLE ${table}`);
  return rows?.[0]?.Checksum ?? "x";
}

export async function GET() {
  try {
    const [opts, accts, bot] = await Promise.all([
      checksum(optionsPool, "options_trades"),
      // Accounts matter too: relinking strategies or renaming an account
      // changes how the report groups rows without touching options_trades.
      checksum(optionsPool, "trading_accounts"),
      checksum(botPool, "bot_entries"),
    ]);
    return NextResponse.json(
      { version: `${opts}.${accts}.${bot}` },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

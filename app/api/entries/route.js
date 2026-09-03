import { NextResponse } from "next/server";
import pool from "../../../lib/db";
import { ALL_FIELDS } from "../../../lib/fields";

export const dynamic = "force-dynamic";

// Columns we accept on insert (header + metrics + bot details).
const INSERT_COLUMNS = ALL_FIELDS.map((f) => f.key);
const NUMERIC_KEYS = new Set(
  ALL_FIELDS.filter((f) => f.format !== "text").map((f) => f.key)
);

// GET /api/entries?symbol=Ethereum&account=Main&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the most recent matching entry plus a recent list.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol   = searchParams.get("symbol");
  const account  = searchParams.get("account");
  const exchange = searchParams.get("exchange");
  const from    = searchParams.get("from");
  const to      = searchParams.get("to");
  // Caller-controlled so the log page can widen its window. The old hard 50
  // silently hid anything older than the 50 newest rows, which made a
  // correctly-saved entry look lost the moment 50 newer ones existed.
  const limit   = Math.min(1000, Math.max(1, parseInt(searchParams.get("limit") || "200", 10) || 200));

  const where = [];
  const params = [];
  if (symbol) {
    where.push("token_symbol = ?");
    params.push(symbol);
  }
  if (account) {
    where.push("account = ?");
    params.push(account);
  }
  if (exchange) {
    where.push("exchange = ?");
    params.push(exchange);
  }
  if (from) {
    where.push("entry_datetime >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    where.push("entry_datetime <= ?");
    params.push(`${to} 23:59:59`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const [rows] = await pool.query(
      // limit+1 so the caller can tell a full page from a truncated one.
      `SELECT * FROM bot_entries ${whereSql} ORDER BY entry_datetime DESC, id DESC LIMIT ?`,
      [...params, limit + 1]
    );
    const truncated = rows.length > limit;
    if (truncated) rows.length = limit;
    const [symbolRows] = await pool.query(
      `SELECT DISTINCT token_symbol, exchange FROM bot_entries WHERE token_symbol IS NOT NULL AND token_symbol != '' ORDER BY exchange, token_symbol`
    );
    const [accountRows] = await pool.query(
      `SELECT DISTINCT account, exchange FROM bot_entries WHERE account IS NOT NULL AND account != '' ORDER BY exchange, account`
    );
    const [exchangeRows] = await pool.query(
      `SELECT DISTINCT exchange FROM bot_entries WHERE exchange IS NOT NULL AND exchange != '' ORDER BY exchange`
    );
    // Capital behind each coin, as the entry log records it. This is the whole
    // book for the coin — bot and options together — so it is the figure the
    // options result should be measured against, and it is deliberately read
    // from the full table rather than the requested window: the allocation is
    // a standing fact about the account, not a property of the date range.
    //
    // The latest value per (account, symbol) wins; investments get revised,
    // and the current one is the one that describes the position today.
    const [investmentRows] = await pool.query(
      `SELECT account, token_symbol,
              SUBSTRING_INDEX(
                GROUP_CONCAT(investment ORDER BY entry_datetime DESC, id DESC), ',', 1
              ) AS investment
         FROM bot_entries
        WHERE investment IS NOT NULL AND investment > 0
          AND account IS NOT NULL AND account != ''
          AND token_symbol IS NOT NULL AND token_symbol != ''
        GROUP BY account, token_symbol`
    );
    const remapped = rows.map(recomputeNetPnl);
    return NextResponse.json({
      latest: remapped[0] || null,
      entries: remapped,
      symbols: symbolRows.map((r) => r.token_symbol),
      // symbol -> exchange, so the Symbol dropdown can narrow with Exchange
      symbolExchange: Object.fromEntries(symbolRows.map((r) => [r.token_symbol, r.exchange])),
      accounts: accountRows.map((r) => r.account),
      // account -> exchange, so the UI can group without a second round trip
      accountExchange: Object.fromEntries(accountRows.map((r) => [r.account, r.exchange])),
      exchanges: exchangeRows.map((r) => r.exchange),
      // [{ account, token_symbol, investment }] — see the query above.
      investments: investmentRows.map((r) => ({
        account: r.account,
        token_symbol: r.token_symbol,
        investment: Number(r.investment),
      })),
      truncated,
      limit,
    });
  } catch (err) {
    return NextResponse.json(
      { error: dbErrorMessage(err) },
      { status: 500 }
    );
  }
}

// POST /api/entries  — insert a manually entered record.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.token_name) {
    return NextResponse.json({ error: "Token Name is required." }, { status: 400 });
  }

  // entry_datetime: use provided value or now.
  const entryDatetime = body.entry_datetime
    ? String(body.entry_datetime).replace("T", " ")
    : new Date().toISOString().slice(0, 19).replace("T", " ");

  const columns = ["entry_datetime", ...INSERT_COLUMNS];
  const values = [
    entryDatetime,
    ...INSERT_COLUMNS.map((key) => {
      const raw = body[key];
      if (NUMERIC_KEYS.has(key)) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
      }
      return raw ?? null;
    }),
  ];

  const placeholders = columns.map(() => "?").join(", ");

  try {
    const [result] = await pool.query(
      `INSERT INTO bot_entries (${columns.join(", ")}) VALUES (${placeholders})`,
      values
    );
    return NextResponse.json({ ok: true, id: result.insertId }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: dbErrorMessage(err) },
      { status: 500 }
    );
  }
}

// Net PNL = RTP PNL + Rebates (Gamma Booked and Flatten shown for reference, excluded)
function recomputeNetPnl(row) {
  const n = (v) => Number(v) || 0;
  return { ...row, net_pnl: n(row.rtp_pnl) + n(row.rebates) };
}

function dbErrorMessage(err) {
  if (err && err.code === "ER_NO_SUCH_TABLE") {
    return "Table 'bot_entries' not found. Run the schema.sql / `npm run db:init` first.";
  }
  if (err && (err.code === "ECONNREFUSED" || err.code === "ER_ACCESS_DENIED_ERROR")) {
    return "Cannot connect to MySQL. Check your .env.local credentials.";
  }
  return err && err.message ? err.message : "Database error.";
}

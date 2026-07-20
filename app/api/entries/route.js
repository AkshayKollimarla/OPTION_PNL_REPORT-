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
  const symbol  = searchParams.get("symbol");
  const account = searchParams.get("account");
  const from    = searchParams.get("from");
  const to      = searchParams.get("to");

  const where = [];
  const params = [];
  if (symbol) {
    where.push("token_symbol = ?");
    params.push(symbol);
  }
  if (account) {
    where.push("token_name = ?");
    params.push(account);
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
      `SELECT * FROM bot_entries ${whereSql} ORDER BY entry_datetime DESC, id DESC LIMIT 50`,
      params
    );
    const [symbolRows] = await pool.query(
      `SELECT DISTINCT token_symbol FROM bot_entries WHERE token_symbol IS NOT NULL AND token_symbol != '' ORDER BY token_symbol`
    );
    const [accountRows] = await pool.query(
      `SELECT DISTINCT token_name FROM bot_entries WHERE token_name IS NOT NULL AND token_name != '' ORDER BY token_name`
    );
    const remapped = rows.map(recomputeNetPnl);
    return NextResponse.json({
      latest: remapped[0] || null,
      entries: remapped,
      symbols: symbolRows.map((r) => r.token_symbol),
      accounts: accountRows.map((r) => r.token_name),
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

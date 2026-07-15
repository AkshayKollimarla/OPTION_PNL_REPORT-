import { NextResponse } from "next/server";
import pool from "../../../../lib/options-db";
import { computeDerived, DERIVED_FIELDS } from "../../../../lib/options-calculations";

export const dynamic = "force-dynamic";

const MANUAL_COLS = [
  "entry_date","token","option_type","investment","options_strike","expiry",
  "opt_entry_qty","opt_entry_price","opt_exit_price","iv",
  "fut_qty","fut_entry_price","fut_exit_price","fut_instrument_type",
  "upside_distance","down_distance","basket_distance","basket_loss",
  "net_booked_pnl","market_making_pl","end_date","status","group_id",
  "execution_log","target_pnl","initial_collateral_usd","account_id",
];
const ALL_COLS = [...MANUAL_COLS, ...DERIVED_FIELDS];

// Auto-add new columns if they don't exist yet (safe to call repeatedly)
let _colsMigrated = false;
async function ensureColumns() {
  if (_colsMigrated) return;
  for (const [col, def] of [
    ["iv",                     "VARCHAR(20) NULL"],
    ["execution_log",          "LONGTEXT NULL"],
    ["target_pnl",             "DECIMAL(12,4) NULL"],
    ["initial_collateral_usd", "DECIMAL(14,4) NULL"],
    ["account_id",             "INT NULL"],
    ["fut_instrument_type",    "VARCHAR(20) NULL DEFAULT 'inverse'"],
  ]) {
    try { await pool.query(`ALTER TABLE options_trades ADD COLUMN ${col} ${def}`); }
    catch { /* column already exists */ }
  }
  _colsMigrated = true;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const status  = searchParams.get("status");
  const groupId = searchParams.get("group_id");
  const token   = (searchParams.get("token") || "").trim();
  const dateFrom= searchParams.get("date_from") || "";
  const dateTo  = searchParams.get("date_to")   || "";

  // Pagination (ignored when fetching by group_id)
  const page  = Math.max(1, parseInt(searchParams.get("page")  || "1", 10));
  const limit = Math.min(9999, Math.max(10, parseInt(searchParams.get("limit") || "50", 10)));
  const offset= (page - 1) * limit;

  const conditions = [];
  const params     = [];

  if (groupId) {
    // Fetch all members of a combined group — no pagination
    conditions.push("group_id = ?");
    params.push(groupId);
  } else {
    if (status && status !== "all") {
      conditions.push("status = ?");
      params.push(status);
    }
    if (token) {
      conditions.push("token LIKE ?");
      params.push(`%${token}%`);
    }
    if (dateFrom) {
      conditions.push("entry_date >= ?");
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push("entry_date <= ?");
      params.push(dateTo);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const ORDER = `ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END,
                 entry_date DESC, id DESC`;

  await ensureColumns();
  try {
    if (groupId) {
      // No pagination for group fetch
      const [rows] = await pool.query(
        `SELECT * FROM options_trades ${where} ${ORDER}`,
        params
      );
      return NextResponse.json({ trades: rows });
    }

    // Parallel: count + page data
    const [[countRows], [rows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM options_trades ${where}`, params),
      pool.query(
        `SELECT * FROM options_trades ${where} ${ORDER} LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
    ]);

    const total = countRows[0].total;
    const pages = Math.ceil(total / limit);

    return NextResponse.json({ trades: rows, total, page, pages, limit });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  await ensureColumns();
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  if (!body.token) return NextResponse.json({ error: "Token is required." }, { status: 400 });

  const derived = computeDerived(body);
  const row     = { ...body, ...derived };

  const cols   = ALL_COLS.filter((c) => row[c] !== undefined && row[c] !== "");
  const vals   = cols.map((c) => {
    const v = row[c];
    if (v === "" || v === null || v === undefined) return null;
    return v;
  });
  const placeholders = cols.map(() => "?").join(", ");

  try {
    const [result] = await pool.query(
      `INSERT INTO options_trades (${cols.join(", ")}) VALUES (${placeholders})`,
      vals
    );
    return NextResponse.json({ ok: true, id: result.insertId }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

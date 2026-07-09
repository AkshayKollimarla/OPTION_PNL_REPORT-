import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_accounts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      exchange    VARCHAR(50)  NOT NULL,
      api_key     VARCHAR(255) DEFAULT NULL,
      api_secret  TEXT         DEFAULT NULL,
      private_key TEXT         DEFAULT NULL,
      testnet     TINYINT(1)   NOT NULL DEFAULT 0,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function GET() {
  await ensureTable();
  const [rows] = await pool.query(
    `SELECT id, name, exchange, api_key, testnet, created_at
     FROM trading_accounts
     ORDER BY created_at DESC`
  );
  return NextResponse.json({ accounts: rows });
}

export async function POST(request) {
  await ensureTable();
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { name, exchange, api_key, api_secret, private_key, testnet = false } = body;
  if (!name || !exchange) {
    return NextResponse.json({ error: "name and exchange are required" }, { status: 400 });
  }

  const [result] = await pool.query(
    `INSERT INTO trading_accounts (name, exchange, api_key, api_secret, private_key, testnet)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, exchange, api_key || null, api_secret || null, private_key || null, testnet ? 1 : 0]
  );
  return NextResponse.json({ ok: true, id: result.insertId }, { status: 201 });
}

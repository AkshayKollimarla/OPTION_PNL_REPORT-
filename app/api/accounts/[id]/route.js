import { NextResponse } from "next/server";
import pool from "../../../../lib/options-db";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = params;
  const [rows] = await pool.query(
    `SELECT id, name, exchange, api_key, api_secret, private_key, testnet
     FROM trading_accounts WHERE id = ?`,
    [id]
  );
  if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ account: rows[0] });
}

export async function DELETE(request, { params }) {
  const { id } = params;
  await pool.query(`DELETE FROM trading_accounts WHERE id = ?`, [id]);
  return NextResponse.json({ ok: true });
}

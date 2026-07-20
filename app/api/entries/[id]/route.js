import { NextResponse } from "next/server";
import pool from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  try {
    const [rows] = await pool.query(
      "SELECT * FROM bot_entries WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    }
    return NextResponse.json({ entry: recomputeNetPnl(rows[0]) });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function recomputeNetPnl(row) {
  const n = (v) => Number(v) || 0;
  return { ...row, net_pnl: n(row.rtp_pnl) + n(row.rebates) };
}

export async function DELETE(_req, { params }) {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  try {
    const [result] = await pool.query(
      "DELETE FROM bot_entries WHERE id = ?",
      [id]
    );
    if (result.affectedRows === 0) {
      return NextResponse.json({ error: "Entry not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

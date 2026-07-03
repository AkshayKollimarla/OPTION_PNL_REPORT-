import { NextResponse } from "next/server";
import pool from "../../../../../lib/options-db";
import { computeDerived, DERIVED_FIELDS } from "../../../../../lib/options-calculations";

export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  const id = Number(params.id);
  try {
    const [rows] = await pool.query("SELECT * FROM options_trades WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ trade: rows[0] });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Empty strings must become NULL for DATE and numeric columns in MySQL strict mode.
const sanitize = (v) => (v === "" || v === undefined) ? null : v;

export async function PUT(request, { params }) {
  const id = Number(params.id);
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  try {
    // Fetch existing row, merge update, re-compute derived
    const [rows] = await pool.query("SELECT * FROM options_trades WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const merged  = { ...rows[0], ...body };
    const derived = computeDerived(merged);
    const final   = { ...merged, ...derived };

    const updateable = [
      "entry_date","token","option_type","investment","options_strike","expiry",
      "opt_entry_qty","opt_entry_price","opt_exit_price",
      "fut_qty","fut_entry_price","fut_exit_price",
      "upside_distance","down_distance","basket_distance","basket_loss",
      "net_booked_pnl","market_making_pl","end_date","status","group_id",
      ...DERIVED_FIELDS,
    ];

    const sets = updateable.map((c) => `${c} = ?`).join(", ");
    const vals = [...updateable.map((c) => sanitize(final[c])), id];

    await pool.query(`UPDATE options_trades SET ${sets} WHERE id = ?`, vals);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req, { params }) {
  const id = Number(params.id);
  try {
    const [result] = await pool.query("DELETE FROM options_trades WHERE id = ?", [id]);
    if (result.affectedRows === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

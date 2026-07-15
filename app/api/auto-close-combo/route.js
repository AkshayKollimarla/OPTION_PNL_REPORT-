import { NextResponse } from "next/server";
import pool from "@/lib/options-db.js";
import { ensureComboTables, startComboWorker } from "@/lib/auto-close-combo-worker.js";
import { sendTelegramAlert } from "@/lib/telegram.js";

// GET   /api/auto-close-combo?group_id=X   → list combo jobs (optionally filtered)
// GET   /api/auto-close-combo?id=X         → single job + its legs
// POST  /api/auto-close-combo               → create combo job with N legs
// PATCH /api/auto-close-combo?id=X          → edit target_pnl on a running job
// DELETE /api/auto-close-combo?id=X         → stop job
//
// Every handler ensures the tables exist and the polling loop is running
// before touching the DB — same self-healing pattern as /api/auto-close.

export async function GET(req) {
  try {
    await ensureComboTables();
    startComboWorker();
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get("group_id");
    const jobId   = searchParams.get("id");

    if (jobId) {
      const [[job]] = await pool.query(`SELECT * FROM auto_close_combo_jobs WHERE id=?`, [jobId]);
      if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
      try { job.logs = JSON.parse(job.log_json || "[]"); } catch { job.logs = []; }
      delete job.log_json;
      const [legs] = await pool.query(
        `SELECT * FROM auto_close_combo_legs WHERE combo_job_id=? ORDER BY leg_index`, [jobId]
      );
      return NextResponse.json({ job, legs });
    }

    const where = groupId ? "WHERE group_id = ?" : "";
    const args  = groupId ? [groupId] : [];
    const [rows] = await pool.query(
      `SELECT id, group_id, account_id, token, initial_total_usd, final_equity_usd,
              target_pnl, target_total_usd, status, last_equity_usd, last_checked_at,
              created_at, triggered_at, completed_at, error_msg
         FROM auto_close_combo_jobs ${where}
        ORDER BY created_at DESC`,
      args
    );
    return NextResponse.json({ jobs: rows });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST body: {
//   group_id, account_id, token, initial_total_usd, target_pnl,
//   legs: [{ leg_type, opt_instrument, opt_qty, opt_dir, opt_entry_price,
//            fut_instrument, fut_qty, fut_dir, fut_entry_price }, ...]
// }
export async function POST(req) {
  try {
    await ensureComboTables();
    startComboWorker();
    const body = await req.json();
    const {
      group_id, account_id, token,
      initial_total_usd, target_pnl,
      legs,
    } = body;

    const missing = ["account_id", "token", "initial_total_usd", "target_pnl"]
      .filter(k => body[k] == null || body[k] === "");
    if (missing.length) {
      return NextResponse.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400 });
    }
    if (!Array.isArray(legs) || legs.length === 0) {
      return NextResponse.json({ error: "legs must be a non-empty array" }, { status: 400 });
    }

    // Prevent two overlapping combo jobs from independently closing the same group
    if (group_id) {
      const [[existing]] = await pool.query(
        `SELECT id, status FROM auto_close_combo_jobs
          WHERE group_id = ? AND status IN ('active','closing')
          LIMIT 1`,
        [group_id]
      );
      if (existing) {
        return NextResponse.json(
          { error: `Job #${existing.id} is already ${existing.status} for this combo. Stop it before starting a new one.`, existing_job_id: existing.id },
          { status: 409 }
        );
      }
    }

    const target_total_usd = parseFloat(initial_total_usd) + parseFloat(target_pnl);

    const [result] = await pool.query(
      `INSERT INTO auto_close_combo_jobs
         (group_id, account_id, token, initial_total_usd, target_pnl, target_total_usd)
       VALUES (?,?,?,?,?,?)`,
      [group_id || null, account_id, token, parseFloat(initial_total_usd), parseFloat(target_pnl), target_total_usd]
    );
    const jobId = result.insertId;

    const legRows = legs.map((leg, i) => {
      const optEntryPrice = leg.opt_entry_price != null && leg.opt_entry_price !== "" ? parseFloat(leg.opt_entry_price) : null;
      const futEntryPrice = leg.fut_entry_price != null && leg.fut_entry_price !== "" ? parseFloat(leg.fut_entry_price) : null;
      return [
        jobId, i, leg.leg_type || null,
        leg.opt_instrument || "", parseFloat(leg.opt_qty) || 0, leg.opt_dir || "sell", optEntryPrice,
        leg.fut_instrument || "", parseFloat(leg.fut_qty) || 0, leg.fut_dir || "sell", futEntryPrice,
      ];
    });
    await pool.query(
      `INSERT INTO auto_close_combo_legs
         (combo_job_id, leg_index, leg_type, opt_instrument, opt_qty, opt_dir, opt_entry_price,
          fut_instrument, fut_qty, fut_dir, fut_entry_price)
       VALUES ?`,
      [legRows]
    );

    const legSummary = legs.map((leg, i) => {
      const bits = [`Leg ${i + 1} (${leg.leg_type || "?"}): ${leg.opt_instrument || "—"}`];
      if (leg.opt_entry_price) bits.push(`opt $${parseFloat(leg.opt_entry_price).toFixed(4)}`);
      if (leg.fut_entry_price) bits.push(`fut $${parseFloat(leg.fut_entry_price).toFixed(2)}`);
      return bits.join(" · ");
    });

    const alertResult = await sendTelegramAlert(
      [
        `🟢 <b>Combo Auto-Close Monitor Started</b> — Job #${jobId}`,
        `${legs.length} legs`,
        ``,
        ...legSummary,
        ``,
        `Initial collateral: $${parseFloat(initial_total_usd).toFixed(2)}`,
        `Target: +$${parseFloat(target_pnl).toFixed(2)} → closes at $${target_total_usd.toFixed(2)}`,
      ].join("\n")
    );

    const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = alertResult.ok
      ? `[${ts}] Telegram entry alert sent.`
      : `[${ts}] Telegram entry alert FAILED: ${alertResult.error}`;
    await pool.query(
      `UPDATE auto_close_combo_jobs SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?) WHERE id=?`,
      [line, jobId]
    ).catch(() => {});

    return NextResponse.json({ id: jobId, target_total_usd, telegram_ok: alertResult.ok });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    await ensureComboTables();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const body = await req.json();
    const newTargetPnl = parseFloat(body.target_pnl);
    if (!(newTargetPnl > 0)) {
      return NextResponse.json({ error: "target_pnl must be a number > 0" }, { status: 400 });
    }

    const [[job]] = await pool.query(`SELECT * FROM auto_close_combo_jobs WHERE id=?`, [id]);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (job.status !== "active") {
      return NextResponse.json({ error: `Job is ${job.status} — target can only be edited while still active` }, { status: 400 });
    }

    const newTargetTotal = parseFloat(job.initial_total_usd) + newTargetPnl;
    await pool.query(
      `UPDATE auto_close_combo_jobs SET target_pnl=?, target_total_usd=?, approach_alert_sent=0 WHERE id=?`,
      [newTargetPnl, newTargetTotal, id]
    );

    await sendTelegramAlert(
      [
        `✏️ <b>Combo Auto-Close Target Updated</b> — Job #${id}`,
        `New target: +$${newTargetPnl.toFixed(2)} → closes at $${newTargetTotal.toFixed(2)}`,
      ].join("\n")
    );

    return NextResponse.json({ ok: true, target_pnl: newTargetPnl, target_total_usd: newTargetTotal });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    await ensureComboTables();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const [[job]] = await pool.query(`SELECT status FROM auto_close_combo_jobs WHERE id=?`, [id]);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (["completed", "failed", "stopped"].includes(job.status)) {
      return NextResponse.json({ error: `Job already ${job.status}` }, { status: 400 });
    }

    await pool.query(
      `UPDATE auto_close_combo_jobs SET status='stopped', completed_at=NOW() WHERE id=?`, [id]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

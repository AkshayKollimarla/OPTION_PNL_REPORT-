import { NextResponse } from "next/server";
import pool from "@/lib/options-db.js";
import { ensureAutoCloseTable, startWorker } from "@/lib/auto-close-worker.js";
import { sendTelegramAlert } from "@/lib/telegram.js";

// GET   /api/auto-close?trade_id=X       → list jobs (optionally filtered)
// POST  /api/auto-close                   → create job
// PATCH /api/auto-close?id=X              → edit target_pnl on a running job
// DELETE /api/auto-close?id=X             → stop job
//
// Every handler ensures the table exists and the polling loop is running
// before touching the DB — self-heals a dev server that was already running
// before instrumentation.js existed, instead of requiring a restart.

export async function GET(req) {
  try {
    await ensureAutoCloseTable();
    startWorker();
    const { searchParams } = new URL(req.url);
    const tradeId = searchParams.get("trade_id");
    const jobId   = searchParams.get("id");

    if (jobId) {
      const [[job]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [jobId]);
      if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
      // Parse log_json
      try { job.logs = JSON.parse(job.log_json || "[]"); } catch { job.logs = []; }
      delete job.log_json;
      return NextResponse.json({ job });
    }

    const where = tradeId ? "WHERE trade_id = ?" : "";
    const args  = tradeId ? [tradeId] : [];
    const [rows] = await pool.query(
      `SELECT id, trade_id, account_id, token, opt_instrument, fut_instrument,
              opt_entry_price, opt_close_price, fut_entry_price, fut_close_price,
              initial_total_usd, final_equity_usd, target_pnl, target_total_usd, status,
              last_equity_usd, last_checked_at, created_at, triggered_at, completed_at,
              error_msg
         FROM auto_close_jobs ${where}
        ORDER BY created_at DESC`,
      args
    );
    return NextResponse.json({ jobs: rows });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await ensureAutoCloseTable();
    startWorker();
    const body = await req.json();
    const {
      trade_id,
      account_id,
      token,
      opt_instrument,
      opt_qty,
      opt_dir,
      opt_entry_price,
      fut_instrument = "",
      fut_qty        = 0,
      fut_dir        = "sell",
      fut_entry_price,
      initial_total_usd,
      target_pnl,
    } = body;

    // Validate required fields
    const missing = ["account_id","token","opt_instrument","opt_qty","opt_dir","initial_total_usd","target_pnl"]
      .filter(k => body[k] == null || body[k] === "");
    if (missing.length) {
      return NextResponse.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400 });
    }

    // Prevent two overlapping jobs from independently closing the same position
    if (trade_id) {
      const [[existing]] = await pool.query(
        `SELECT id, status FROM auto_close_jobs
          WHERE trade_id = ? AND status IN ('active','closing_option','closing_futures')
          LIMIT 1`,
        [trade_id]
      );
      if (existing) {
        return NextResponse.json(
          { error: `Job #${existing.id} is already ${existing.status} for this strategy. Stop it before starting a new one.`, existing_job_id: existing.id },
          { status: 409 }
        );
      }
    }

    const target_total_usd = parseFloat(initial_total_usd) + parseFloat(target_pnl);
    const optEntryPrice = opt_entry_price != null && opt_entry_price !== "" ? parseFloat(opt_entry_price) : null;
    const futEntryPrice = fut_entry_price != null && fut_entry_price !== "" ? parseFloat(fut_entry_price) : null;

    const [result] = await pool.query(
      `INSERT INTO auto_close_jobs
         (trade_id, account_id, token, opt_instrument, opt_qty, opt_dir, opt_entry_price,
          fut_instrument, fut_qty, fut_dir, fut_entry_price,
          initial_total_usd, target_pnl, target_total_usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trade_id || null,
        account_id, token, opt_instrument,
        parseFloat(opt_qty), opt_dir, optEntryPrice,
        fut_instrument, parseFloat(fut_qty), fut_dir, futEntryPrice,
        parseFloat(initial_total_usd), parseFloat(target_pnl), target_total_usd,
      ]
    );

    const jobId = result.insertId;

    const alertResult = await sendTelegramAlert(
      [
        `🟢 <b>Auto-Close Monitor Started</b> — Job #${jobId}`,
        `${opt_instrument}${fut_instrument ? ` + ${fut_instrument}` : ""}`,
        ``,
        optEntryPrice != null ? `Option entry: $${optEntryPrice.toFixed(4)}` : null,
        futEntryPrice != null ? `Futures entry: $${futEntryPrice.toFixed(2)}` : null,
        ``,
        `Initial collateral: $${parseFloat(initial_total_usd).toFixed(2)}`,
        `Target: +$${parseFloat(target_pnl).toFixed(2)} → closes at $${target_total_usd.toFixed(2)}`,
      ].filter(Boolean).join("\n")
    );

    // Persist the outcome into the job's own log so a failed alert is
    // visible in the app (Monitor page / job logs) — not just a console
    // line in a terminal that's long gone by the time anyone checks.
    const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = alertResult.ok
      ? `[${ts}] Telegram entry alert sent.`
      : `[${ts}] Telegram entry alert FAILED: ${alertResult.error}`;
    await pool.query(
      `UPDATE auto_close_jobs SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?) WHERE id=?`,
      [line, jobId]
    ).catch(() => {});

    return NextResponse.json({ id: jobId, target_total_usd, telegram_ok: alertResult.ok });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    await ensureAutoCloseTable();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const body = await req.json();
    const newTargetPnl = parseFloat(body.target_pnl);
    if (!(newTargetPnl > 0)) {
      return NextResponse.json({ error: "target_pnl must be a number > 0" }, { status: 400 });
    }

    const [[job]] = await pool.query(`SELECT * FROM auto_close_jobs WHERE id=?`, [id]);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (job.status !== "active") {
      return NextResponse.json({ error: `Job is ${job.status} — target can only be edited while still active (before it starts closing)` }, { status: 400 });
    }

    // Keep the same frozen initial_total_usd baseline — only the target moves.
    const newTargetTotal = parseFloat(job.initial_total_usd) + newTargetPnl;
    await pool.query(
      `UPDATE auto_close_jobs SET target_pnl=?, target_total_usd=?, approach_alert_sent=0 WHERE id=?`,
      [newTargetPnl, newTargetTotal, id]
    );

    await sendTelegramAlert(
      [
        `✏️ <b>Auto-Close Target Updated</b> — Job #${id}`,
        `${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`,
        ``,
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
    await ensureAutoCloseTable();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const [[job]] = await pool.query(`SELECT status FROM auto_close_jobs WHERE id=?`, [id]);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (["completed","failed","stopped"].includes(job.status)) {
      return NextResponse.json({ error: `Job already ${job.status}` }, { status: 400 });
    }

    await pool.query(
      `UPDATE auto_close_jobs SET status='stopped', completed_at=NOW() WHERE id=?`, [id]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

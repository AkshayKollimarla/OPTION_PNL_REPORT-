"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

const STATUS_COLOR = {
  active:           "bg-blue-100 text-blue-700",
  closing_option:   "bg-yellow-100 text-yellow-700",
  closing_futures:  "bg-orange-100 text-orange-700",
  closing:          "bg-yellow-100 text-yellow-700",
  failed:           "bg-red-100 text-red-700",
  completed:        "bg-emerald-100 text-emerald-700",
  stopped:          "bg-slate-100 text-slate-500",
};

function Bar({ pct, color = "emerald" }) {
  const cls = { emerald: "bg-emerald-500", blue: "bg-blue-500", orange: "bg-orange-500" }[color] || "bg-emerald-500";
  const safe = Math.min(100, Math.max(0, pct));
  return (
    <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-700 ${cls}`} style={{ width: `${safe}%` }} />
    </div>
  );
}

function pnlAndPct(job) {
  const pnl = job.last_equity_usd != null ? Number(job.last_equity_usd) - Number(job.initial_total_usd || 0) : null;
  const tgt = Number(job.target_pnl || 0);
  const pct = pnl != null && tgt > 0 ? Math.min(100, Math.max(0, (pnl / tgt) * 100)) : 0;
  return { pnl, pct };
}

function fmtCcy(v) {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

// Click to expand — for a "completed"/"stopped" job this is often the ONLY
// place its outcome is visible at all, since its options_trades record may
// have since been deleted (the normal "View Full Monitor" link depends on
// that record existing). Failed jobs show their error right here too,
// without needing a working trade link to find out why.
function StrategyRow({ href, badge, title, subtitle, job, kind }) {
  const [expanded, setExpanded] = useState(false);
  const [fullLog,  setFullLog]  = useState(null);
  const [logErr,   setLogErr]   = useState(null);
  const [loadingLog, setLoadingLog] = useState(false);

  const { pnl, pct } = pnlAndPct(job);
  const isFailed    = job.status === "failed";
  const isCompleted = job.status === "completed";
  const isStopped   = job.status === "stopped";
  const isDone      = isCompleted || isStopped;

  const finalPnl = job.final_equity_usd != null
    ? Number(job.final_equity_usd) - Number(job.initial_total_usd || 0)
    : null;

  async function loadFullLog() {
    if (fullLog || loadingLog) return;
    setLoadingLog(true); setLogErr(null);
    try {
      const url = kind === "combo" ? `/api/auto-close-combo?id=${job.id}` : `/api/auto-close?id=${job.id}`;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setFullLog(d.job?.logs || []);
    } catch (e) {
      setLogErr(e.message);
    } finally {
      setLoadingLog(false);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next) loadFullLog();
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {badge}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-slate-800 truncate">{title}</p>
              {subtitle && <p className="text-xs text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-5 shrink-0">
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLOR[job.status] || "bg-slate-100 text-slate-500"}`}>
              {job.status}
            </span>
            <div className="text-right w-32">
              {isFailed ? (
                <p className="text-xs text-red-500 truncate" title={job.error_msg || ""}>{job.error_msg || "Stopped — needs resume"}</p>
              ) : isDone ? (
                <p className={`text-sm font-bold ${finalPnl == null ? "text-slate-400" : finalPnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {finalPnl != null ? fmtCcy(finalPnl) : isCompleted ? "Completed" : "Stopped"}
                </p>
              ) : (
                <p className={`text-sm font-bold ${pnl != null && pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {pnl != null ? fmtCcy(pnl) : "—"} <span className="text-slate-400 font-normal">/ +${Number(job.target_pnl || 0).toFixed(2)}</span>
                </p>
              )}
            </div>
            <span className="text-slate-300 text-xs">{expanded ? "▲" : "▼"}</span>
          </div>
        </div>
        {!isFailed && !isDone && (
          <div className="mt-3">
            <Bar pct={pct} color={pct >= 100 ? "emerald" : pct > 50 ? "blue" : "orange"} />
          </div>
        )}
      </button>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-4 space-y-3">
          {/* Outcome summary — the actual answer to "did it finish, or error?" */}
          {isFailed && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
              <span className="font-semibold">Failed — </span>{job.error_msg || "unknown error"}
            </div>
          )}
          {isCompleted && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 space-y-1">
              <p className="font-semibold">✓ Completed successfully</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs text-emerald-800">
                {job.opt_close_price != null && <p>Option close: ${Number(job.opt_close_price).toFixed(4)}</p>}
                {job.fut_close_price != null && <p>Futures close: ${Number(job.fut_close_price).toFixed(2)}</p>}
                {job.final_equity_usd != null && <p>Final equity: ${Number(job.final_equity_usd).toFixed(2)}</p>}
                <p className="font-semibold">Net PnL: {finalPnl != null ? fmtCcy(finalPnl) : "—"}</p>
              </div>
            </div>
          )}
          {isStopped && (
            <div className="rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm text-slate-600">
              Stopped — no further monitoring or orders for this job.
            </div>
          )}

          {/* Full execution log, fetched on demand */}
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Execution Log</p>
            {loadingLog ? (
              <p className="text-xs text-slate-400">Loading…</p>
            ) : logErr ? (
              <p className="text-xs text-red-500">{logErr}</p>
            ) : fullLog && fullLog.length ? (
              <div className="max-h-56 overflow-y-auto rounded-lg bg-slate-900 px-3 py-2 font-mono text-[11px] text-slate-300 space-y-0.5">
                {fullLog.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            ) : (
              <p className="text-xs text-slate-400">No log entries.</p>
            )}
          </div>

          {href && (
            <Link href={href} className="inline-block text-xs font-semibold text-blue-600 hover:underline">
              Open Full Monitor →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export default function MonitorListPage() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const load = useCallback(() => {
    fetch("/api/monitor-list")
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setData(j);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const singleJobs = data?.singleJobs || [];
  const comboJobs  = data?.comboJobs  || [];

  const activeSingle   = singleJobs.filter((j) => !["failed", "completed", "stopped"].includes(j.status));
  const activeCombo    = comboJobs.filter((j) => !["failed", "completed", "stopped"].includes(j.status));
  const failedSingle   = singleJobs.filter((j) => j.status === "failed");
  const failedCombo    = comboJobs.filter((j) => j.status === "failed");
  const resolvedSingle = singleJobs.filter((j) => j.status === "completed" || j.status === "stopped");
  const resolvedCombo  = comboJobs.filter((j) => j.status === "completed" || j.status === "stopped");

  const activeCount   = activeSingle.length + activeCombo.length;
  const failedCount   = failedSingle.length + failedCombo.length;
  const resolvedCount = resolvedSingle.length + resolvedCombo.length;

  function singleHref(j) { return j.trade_id ? `/options/monitor/${j.trade_id}` : null; }
  function comboHref(j)  { return j.trade_id ? `/options/monitor/${j.trade_id}` : (j.group_id ? `/options/simulator?edit_group=${j.group_id}` : null); }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-xl font-bold text-slate-800">Monitor</h1>
      </header>

      <div className="p-6 space-y-6">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-sm text-slate-400">Loading…</div>
        ) : (
          <>
            {/* Active */}
            <section className="space-y-3">
              <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
                Active Strategies {activeCount > 0 && <span className="text-slate-400 font-normal">({activeCount})</span>}
              </h2>
              {activeCount === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-8 text-center text-sm text-slate-400">
                  No active auto-close strategies right now.
                </div>
              ) : (
                <div className="space-y-2">
                  {activeSingle.map((j) => (
                    <StrategyRow
                      key={`single-${j.id}`} kind="single"
                      href={singleHref(j)}
                      badge="Single"
                      title={j.opt_instrument || j.token}
                      subtitle={j.option_type && j.options_strike ? `${j.token} · ${j.option_type} · Strike ${j.options_strike}` : j.token}
                      job={j}
                    />
                  ))}
                  {activeCombo.map((j) => (
                    <StrategyRow
                      key={`combo-${j.id}`} kind="combo"
                      href={comboHref(j)}
                      badge={`Combo · ${j.legs?.length || 0} legs`}
                      title={j.legs?.map((l) => l.leg_type).join(" + ") || j.token}
                      subtitle={`${j.token} · ${j.group_id}`}
                      job={j}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Needs attention */}
            {failedCount > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-bold text-red-600 uppercase tracking-wide">
                  Needs Attention — Failed ({failedCount})
                </h2>
                <div className="space-y-2">
                  {failedSingle.map((j) => (
                    <StrategyRow
                      key={`single-failed-${j.id}`} kind="single"
                      href={singleHref(j)}
                      badge="Single"
                      title={j.opt_instrument || j.token}
                      subtitle={j.option_type && j.options_strike ? `${j.token} · ${j.option_type} · Strike ${j.options_strike}` : j.token}
                      job={j}
                    />
                  ))}
                  {failedCombo.map((j) => (
                    <StrategyRow
                      key={`combo-failed-${j.id}`} kind="combo"
                      href={comboHref(j)}
                      badge={`Combo · ${j.legs?.length || 0} legs`}
                      title={j.legs?.map((l) => l.leg_type).join(" + ") || j.token}
                      subtitle={`${j.token} · ${j.group_id}`}
                      job={j}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Recently resolved — completed or stopped. Click to confirm the
                actual outcome (close prices, net PnL) or see why it stopped,
                even if the strategy's trade record has since been deleted. */}
            {resolvedCount > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wide">
                  Recently Resolved ({resolvedCount})
                </h2>
                <div className="space-y-2">
                  {resolvedSingle.map((j) => (
                    <StrategyRow
                      key={`single-resolved-${j.id}`} kind="single"
                      href={singleHref(j)}
                      badge="Single"
                      title={j.opt_instrument || j.token}
                      subtitle={j.option_type && j.options_strike ? `${j.token} · ${j.option_type} · Strike ${j.options_strike}` : j.token}
                      job={j}
                    />
                  ))}
                  {resolvedCombo.map((j) => (
                    <StrategyRow
                      key={`combo-resolved-${j.id}`} kind="combo"
                      href={comboHref(j)}
                      badge={`Combo · ${j.legs?.length || 0} legs`}
                      title={j.legs?.map((l) => l.leg_type).join(" + ") || j.token}
                      subtitle={`${j.token} · ${j.group_id}`}
                      job={j}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

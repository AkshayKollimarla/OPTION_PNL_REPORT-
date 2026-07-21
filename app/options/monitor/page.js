"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

const STATUS_COLOR = {
  active:           "bg-blue-100 text-blue-700",
  closing_option:   "bg-yellow-100 text-yellow-700",
  closing_futures:  "bg-orange-100 text-orange-700",
  closing:          "bg-yellow-100 text-yellow-700",
  failed:           "bg-red-100 text-red-700",
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

function StrategyRow({ href, badge, title, subtitle, job }) {
  const { pnl, pct } = pnlAndPct(job);
  const isFailed = job.status === "failed";
  return (
    <Link
      href={href}
      className="block rounded-xl border border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow transition-all px-5 py-4"
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
            ) : (
              <>
                <p className={`text-sm font-bold ${pnl != null && pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"} <span className="text-slate-400 font-normal">/ +${Number(job.target_pnl || 0).toFixed(2)}</span>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      {!isFailed && (
        <div className="mt-3">
          <Bar pct={pct} color={pct >= 100 ? "emerald" : pct > 50 ? "blue" : "orange"} />
        </div>
      )}
    </Link>
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

  const activeSingle = singleJobs.filter((j) => j.status !== "failed");
  const activeCombo  = comboJobs.filter((j) => j.status !== "failed");
  const failedSingle = singleJobs.filter((j) => j.status === "failed");
  const failedCombo  = comboJobs.filter((j) => j.status === "failed");

  const activeCount = activeSingle.length + activeCombo.length;
  const failedCount = failedSingle.length + failedCombo.length;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-xl font-bold text-slate-800">Monitor</h1>
      </header>

      <div className="p-6 space-y-6 max-w-4xl">
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
                      key={`single-${j.id}`}
                      href={j.trade_id ? `/options/monitor/${j.trade_id}` : "/options"}
                      badge="Single"
                      title={j.opt_instrument || j.token}
                      subtitle={j.option_type && j.options_strike ? `${j.token} · ${j.option_type} · Strike ${j.options_strike}` : j.token}
                      job={j}
                    />
                  ))}
                  {activeCombo.map((j) => (
                    <StrategyRow
                      key={`combo-${j.id}`}
                      href={j.trade_id ? `/options/monitor/${j.trade_id}` : `/options/simulator?edit_group=${j.group_id}`}
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
                      key={`single-failed-${j.id}`}
                      href={j.trade_id ? `/options/monitor/${j.trade_id}` : "/options"}
                      badge="Single"
                      title={j.opt_instrument || j.token}
                      subtitle={j.option_type && j.options_strike ? `${j.token} · ${j.option_type} · Strike ${j.options_strike}` : j.token}
                      job={j}
                    />
                  ))}
                  {failedCombo.map((j) => (
                    <StrategyRow
                      key={`combo-failed-${j.id}`}
                      href={j.trade_id ? `/options/monitor/${j.trade_id}` : `/options/simulator?edit_group=${j.group_id}`}
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

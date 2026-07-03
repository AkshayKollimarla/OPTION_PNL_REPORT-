"use client";

import { useEffect, useState, useCallback } from "react";

const METRICS = [
  { key: "rtps",          label: "RTPS",        color: "blue"   },
  { key: "rtp_pnl",       label: "RTP PNL",     color: "cyan"   },
  { key: "per_hour_rtps", label: "Per Hour RTP", color: "slate"  },
  { key: "rebates",       label: "Rebates",     color: "orange" },
  { key: "flatten_pnl",   label: "Flatten",     color: "teal"   },
  { key: "gamma_booked",  label: "Booked Gamma",color: "indigo" },
  { key: "net_pnl",       label: "Net PL",      color: "green"  },
  { key: "volume",        label: "Volume",      color: "blue"   },
  { key: "apy",           label: "APY",         color: "purple" },
];

export default function SummaryReport() {
  const [data,      setData]      = useState(null);
  const [date,      setDate]      = useState("");
  const [symbol,    setSymbol]    = useState("all");
  const [symbols,   setSymbols]   = useState([]);
  const [sortCol,   setSortCol]   = useState("net_pnl");
  const [sortDir,   setSortDir]   = useState("desc");
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (date)                    p.set("date",   date);
    if (symbol && symbol !== "all") p.set("symbol", symbol);
    fetch(`/api/summary-report?${p}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setData(j);
        setSymbols(j.symbols || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [date, symbol]);

  useEffect(() => { load(); }, [load]);

  const tokens = data?.tokens || [];

  const sorted = [...tokens].sort((a, b) => {
    const av = Number(a[sortCol] ?? 0);
    const bv = Number(b[sortCol] ?? 0);
    return sortDir === "desc" ? bv - av : av - bv;
  });

  function handleSort(key) {
    if (sortCol === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortCol(key); setSortDir("desc"); }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-xl font-bold text-slate-800">Summary Report</h1>
      </header>

      <div className="p-6 space-y-5">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Date */}
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <span className="text-slate-400">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400">Date</p>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="text-sm font-semibold text-slate-700 bg-transparent outline-none w-full"
              />
            </div>
            {date && (
              <button onClick={() => setDate("")} className="text-slate-300 hover:text-slate-500 text-lg leading-none">×</button>
            )}
          </div>

          {/* Symbol */}
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <span className="text-slate-400">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinejoin="round" />
                <path d="M2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-400">Symbol</p>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="text-sm font-semibold text-slate-700 bg-transparent outline-none w-full"
              >
                <option value="all">All Symbols</option>
                {symbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-sm text-slate-400">Loading…</div>
          ) : sorted.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-sm text-slate-400">No entries found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-5 py-3.5 text-left text-xs font-bold text-slate-800 uppercase tracking-wide">Token</th>
                    {METRICS.map((m) => (
                      <th
                        key={m.key}
                        onClick={() => handleSort(m.key)}
                        className={`px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide cursor-pointer select-none whitespace-nowrap transition-colors ${
                          sortCol === m.key ? "text-blue-600" : "text-slate-800 hover:text-blue-600"
                        }`}
                      >
                        {m.label}{sortCol === m.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {sorted.map((t) => (
                    <tr key={`${t.token_symbol}__${t.token_name}`} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <TokenIcon symbol={t.token_symbol} />
                          <div>
                            <p className="font-semibold text-slate-800">{t.token_symbol}</p>
                            {t.token_name && t.token_name !== t.token_symbol && (
                              <p className="text-xs text-slate-400">{t.token_name}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-right font-medium text-slate-700">{fmtNum(t.rtps, 2)}</td>
                      <td className="px-4 py-4 text-right font-semibold text-emerald-600">{fmtCcy(t.rtp_pnl)}</td>
                      <td className="px-4 py-4 text-right font-medium text-slate-700">{fmtNum(t.per_hour_rtps, 2)}</td>
                      <td className="px-4 py-4 text-right font-semibold text-orange-500">{fmtCcy(t.rebates)}</td>
                      <td className={`px-4 py-4 text-right font-semibold ${Number(t.flatten_pnl) >= 0 ? "text-teal-600" : "text-red-500"}`}>{fmtCcy(t.flatten_pnl)}</td>
                      <td className="px-4 py-4 text-right font-semibold text-indigo-600">{fmtCcy(t.gamma_booked)}</td>
                      <td className={`px-4 py-4 text-right font-bold ${Number(t.net_pnl) >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(t.net_pnl)}</td>
                      <td className="px-4 py-4 text-right font-semibold text-blue-600">{fmtVol(t.volume)}</td>
                      <td className="px-4 py-4 text-right font-semibold text-purple-600">
                        {t.apy != null ? `${Number(t.apy).toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Totals footer */}
        {data && !loading && tokens.length > 0 && (() => {
          const totalRtpPnl     = tokens.reduce((s, t) => s + Number(t.rtp_pnl    || 0), 0);
          const totalFlatten    = tokens.reduce((s, t) => s + Number(t.flatten_pnl || 0), 0);
          const totalRebates    = tokens.reduce((s, t) => s + Number(t.rebates     || 0), 0);
          const totalGamma      = tokens.reduce((s, t) => s + Number(t.gamma_booked|| 0), 0);
          return (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm divide-y divide-slate-100">
              {/* Row 1 — Net PNL (hero) */}
              <div className="flex items-center">
                <div className="flex items-center gap-4 px-6 py-5 border-r border-slate-100 w-48 shrink-0">
                  <div className="h-10 w-10 rounded-full bg-blue-50 flex items-center justify-center">
                    <svg className="h-5 w-5 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="5" rx="9" ry="3" />
                      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
                    </svg>
                  </div>
                  <span className="text-sm font-bold text-slate-700">Totals</span>
                </div>
                <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 px-6 py-5">
                  <TotalCell label="Net PNL"     value={data.totalNetPnl} color={data.totalNetPnl >= 0 ? "emerald" : "red"} />
                  <TotalCell label="RTP PNL"     value={totalRtpPnl}     color="emerald" />
                  <TotalCell label="Flatten"     value={totalFlatten}    color={totalFlatten    >= 0 ? "teal"    : "red"} />
                  <TotalCell label="Rebates"     value={totalRebates}    color="orange" />
                  <TotalCell label="Booked Gamma" value={totalGamma}     color="indigo" />
                </div>
              </div>
              <p className="px-6 py-2 text-xs text-slate-400">
                Across {tokens.length} Token{tokens.length !== 1 ? "s" : ""}
              </p>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────── */

function TotalCell({ label, value, color }) {
  const colorCls = {
    emerald: "text-emerald-600",
    red:     "text-red-600",
    cyan:    "text-cyan-600",
    teal:    "text-teal-600",
    orange:  "text-orange-500",
    indigo:  "text-indigo-600",
  }[color] || "text-slate-700";
  return (
    <div>
      <p className="text-xs text-slate-400 mb-0.5">{label}</p>
      <p className={`text-base font-bold ${colorCls}`}>{fmtCcy(value)}</p>
    </div>
  );
}

const TOKEN_COLORS = [
  ["bg-blue-500",   "text-white"],
  ["bg-purple-500", "text-white"],
  ["bg-emerald-500","text-white"],
  ["bg-orange-500", "text-white"],
  ["bg-pink-500",   "text-white"],
  ["bg-indigo-500", "text-white"],
  ["bg-teal-500",   "text-white"],
  ["bg-red-500",    "text-white"],
  ["bg-amber-500",  "text-white"],
  ["bg-cyan-500",   "text-white"],
];

function TokenIcon({ symbol }) {
  const idx = (symbol || "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % TOKEN_COLORS.length;
  const [bg, fg] = TOKEN_COLORS[idx];
  const abbr = (symbol || "??").slice(0, 2).toUpperCase();
  return (
    <div className={`h-9 w-9 rounded-full ${bg} ${fg} flex items-center justify-center text-xs font-bold shrink-0`}>
      {abbr}
    </div>
  );
}

function MetricIcon({ metricKey, active }) {
  const cls = `h-4 w-4 ${active ? "text-white" : "text-slate-400"}`;
  const icons = {
    rtps:          <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17l4-8 4 4 4-6 4 4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    per_hour_rtps: <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2" strokeLinecap="round"/></svg>,
    rebates:       <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8" strokeLinecap="round"/></svg>,
    flatten_pnl:   <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" strokeLinecap="round"/><path d="M7 16l4-4 4 4 4-6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    gamma_booked:  <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l-3 7H3l6 4.5L7 21l5-3.5L17 21l-2-7.5L21 9h-6z" strokeLinejoin="round"/></svg>,
    net_pnl:       <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l3 3" strokeLinecap="round"/></svg>,
    volume:        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="12" width="4" height="10" rx="1"/><rect x="9" y="8" width="4" height="14" rx="1"/><rect x="16" y="4" width="4" height="18" rx="1"/></svg>,
    apy:           <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="9" r="3"/><circle cx="15" cy="15" r="3"/><path d="M5 20L19 4" strokeLinecap="round"/></svg>,
  };
  return icons[metricKey] || null;
}

/* ── Formatters ──────────────────────────────────────────── */

function fmtCcy(v) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v, decimals = 2) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtVol(v) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

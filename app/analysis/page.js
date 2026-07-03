"use client";

import { useState, useCallback } from "react";
import {
  BOT_DETAILS_LEFT,
  BOT_DETAILS_RIGHT,
  METRIC_CARDS,
  formatValue,
} from "../../lib/fields";

export default function Analysis() {
  const [symbol,   setSymbol]   = useState("");
  const [symbols,  setSymbols]  = useState([]);
  const [account,  setAccount]  = useState("");
  const [accounts, setAccounts] = useState([]);
  const [from,     setFrom]     = useState("");
  const [to,       setTo]       = useState("");

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [fetched, setFetched] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (symbol)  qs.set("symbol",  symbol);
      if (account) qs.set("account", account);
      if (from)    qs.set("from",    from);
      if (to)      qs.set("to",      to);
      const res  = await fetch(`/api/analysis?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      setData(json);
      setSymbols(json.symbols   || []);
      setAccounts(json.accounts || []);
      setFetched(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, account, from, to]);

  // Load filters list on first mount
  useState(() => { load(); }, []);

  const s = data?.stats || {};

  return (
    <div>
      {/* Header */}
      <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-lg font-bold text-slate-800">Analysis</h1>
      </header>

      <div className="p-6 space-y-6">

        {/* Filter bar */}
        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-end">
            <FilterField label="Symbol">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="">All symbols</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </FilterField>
            <FilterField label="Account">
              <select value={account} onChange={(e) => setAccount(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </FilterField>
            <FilterField label="From Date">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </FilterField>
            <FilterField label="To Date">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </FilterField>
            <button onClick={load}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
              {loading ? "Analysing…" : "Run Analysis"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {fetched && Number(s.total_entries) === 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No entries found for the selected filters.
          </div>
        )}

        {fetched && Number(s.total_entries) > 0 && (
          <>
            {/* Summary stat strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatCard label="Total Entries"   value={s.total_entries}  fmt="number" color="slate" />
              <StatCard label="Max RTPS"        value={s.max_rtps}       fmt="number" color="green" />
              <StatCard label="Min RTPS"        value={s.min_rtps}       fmt="number" color="red"   />
              <StatCard label="Avg RTPS"        value={s.avg_rtps}       fmt="number" color="blue"  />
              <StatCard label="Total Net-PNL"   value={s.total_net_pnl}  fmt="currency" color="green" />
              <StatCard label="Total Volume"    value={s.total_volume}   fmt="currency" color="blue"  />
              <StatCard label="Best APY"        value={s.max_apy}        fmt="percent" color="purple" />
              <StatCard label="Worst APY"       value={s.min_apy}        fmt="percent" color="red"   />
              <StatCard label="Avg APY"         value={s.avg_apy}        fmt="percent" color="blue"  />
              <StatCard label="Best Net-PNL"    value={s.max_net_pnl}    fmt="currency" color="green" />
              <StatCard label="Worst Net-PNL"   value={s.min_net_pnl}    fmt="currency" color="red"   />
              <StatCard label="Total RTP-PNL"   value={s.total_rtp_pnl}  fmt="currency" color="blue"  />
            </div>

            {/* Performer cards */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <EntryCard title="Best Performer" subtitle="Highest RTPS"  badge="green"  entry={data.bestRtps}  highlight="rtps" />
              <EntryCard title="Least Performer" subtitle="Lowest RTPS"  badge="red"    entry={data.worstRtps} highlight="rtps" />
              <EntryCard title="Best Net-PNL"    subtitle="Highest Net-PNL" badge="green" entry={data.bestPnl}   highlight="net_pnl" />
              <EntryCard title="Worst Net-PNL"   subtitle="Lowest Net-PNL"  badge="red"   entry={data.worstPnl}  highlight="net_pnl" />
            </div>
          </>
        )}

        {!fetched && !loading && (
          <div className="rounded-lg border border-slate-100 bg-slate-50 px-6 py-10 text-center text-sm text-slate-400">
            Select filters above and click <strong>Run Analysis</strong> to see insights.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

const STAT_COLORS = {
  green:  "text-emerald-600 bg-emerald-50",
  red:    "text-red-600 bg-red-50",
  blue:   "text-blue-600 bg-blue-50",
  purple: "text-purple-600 bg-purple-50",
  slate:  "text-slate-700 bg-slate-100",
};

function StatCard({ label, value, fmt, color = "blue" }) {
  const cls = STAT_COLORS[color] || STAT_COLORS.blue;
  const formatted =
    fmt === "currency" ? formatValue(value, "currency")
    : fmt === "percent" ? formatValue(value, "percent")
    : value != null ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—";
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
      <p className="mb-1 text-xs font-medium text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${cls.split(" ")[0]}`}>{formatted}</p>
    </div>
  );
}

const BADGE = {
  green: "bg-emerald-100 text-emerald-700 border-emerald-200",
  red:   "bg-red-100 text-red-700 border-red-200",
};

function EntryCard({ title, subtitle, badge, entry, highlight }) {
  if (!entry) return null;

  const allMetrics = METRIC_CARDS.map((f) => ({
    ...f,
    isHighlight: f.key === highlight,
  }));

  return (
    <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden">
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
        </div>
        <div className="text-right">
          <span className={`inline-block rounded-full border px-3 py-0.5 text-xs font-semibold ${BADGE[badge]}`}>
            {subtitle}
          </span>
          <p className="mt-1 text-xs text-slate-400">{formatDatetime(entry.entry_datetime)}</p>
        </div>
      </div>

      {/* Token + account row */}
      <div className="flex flex-wrap gap-3 px-5 py-3 border-b border-slate-50 bg-slate-50/50">
        <Chip label="Token"   value={entry.token_name}   />
        <Chip label="Symbol"  value={entry.token_symbol} />
        <Chip label="Account" value={entry.account}      />
        <Chip label="Investment" value={formatValue(entry.investment, "currency")} />
      </div>

      {/* Metric highlights */}
      <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100">
        {allMetrics.map((f) => (
          <div key={f.key}
            className={`px-3 py-3 text-center ${f.isHighlight ? "bg-brand/5" : ""}`}>
            <p className="text-xs text-slate-400 mb-0.5">{f.label}</p>
            <p className={`text-sm font-bold ${f.isHighlight ? "text-brand" : "text-slate-700"}`}>
              {formatValue(entry[f.key], f.format)}
            </p>
          </div>
        ))}
      </div>

      {/* Bot inputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 px-5 py-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Position & Spread</p>
          {BOT_DETAILS_LEFT.map((f) => (
            <DetailRow key={f.key} label={f.label} value={formatValue(entry[f.key], f.format)} />
          ))}
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Baskets & Limits</p>
          {BOT_DETAILS_RIGHT.map((f) => (
            <DetailRow key={f.key} label={f.label} value={formatValue(entry[f.key], f.format)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-slate-400">{label}:</span>
      <span className="font-semibold text-slate-700">{value}</span>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-slate-100 py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-semibold text-slate-700">{value}</span>
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

function formatDatetime(dt) {
  if (!dt) return "—";
  const d = new Date(String(dt).replace(" ", "T"));
  if (isNaN(d)) return String(dt);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

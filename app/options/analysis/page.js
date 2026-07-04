"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import PayoffChart from "../../../components/PayoffChart";

/* ── Formatters ─────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, "0"); }

// Local YYYY-MM-DD from a JS Date — avoids UTC shift on toISOString (IST bug fix)
function localIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Robustly extract a YYYY-MM-DD in LOCAL time from any date value.
// Handles: "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SS.sssZ" (UTC ISO).
// When the DB pool lacks dateStrings:true, mysql2 serialises DATE as UTC ISO like
// "2026-06-23T18:30:00.000Z" (IST midnight June 24 → UTC June 23). new Date() + localIso
// converts that UTC instant back to the correct local day (June 24).
function toLocalDateStr(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // already YYYY-MM-DD
  const dt = new Date(s.replace(" ", "T"));               // handles both space and T separator
  if (isNaN(dt)) return null;
  return localIso(dt);                                    // convert UTC instant → local date
}

// Display as DD-MM-YYYY
function fmt(d) {
  if (!d) return "—";
  const local = toLocalDateStr(d);
  if (!local) return "—";
  const [y, m, day] = local.split("-");
  return `${day}-${m}-${y}`;
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(String(d).replace(" ", "T"));
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtCcy(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v, dec = 2) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  return n.toFixed(dec);
}

function fmtVol(v) {
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtVal(v, format) {
  if (v === null || v === undefined || v === "") return "—";
  if (format === "currency") return fmtCcy(v);
  if (format === "percent")  return `${Number(v).toFixed(2)}%`;
  if (format === "number")   return fmtNum(v, 4);
  return String(v);
}

function baseToken(token) { return token ? token.split("-")[0] : "—"; }

/* ── Options input fields to display ───────────────────── */
const OPT_FIELDS = [
  { key: "token",              label: "Token",              fmt: "text" },
  { key: "option_type",        label: "Option Type",        fmt: "text" },
  { key: "options_strike",     label: "Strike Price",       fmt: "currency" },
  { key: "expiry",             label: "Expiry Date",        fmt: "date" },
  { key: "entry_date",         label: "Entry Date",         fmt: "date" },
  { key: "end_date",           label: "Exit Date",          fmt: "date" },
  { key: "status",             label: "Status",             fmt: "text" },
  { key: "investment",         label: "Investment",         fmt: "currency" },
  { key: "opt_entry_qty",      label: "Opt Entry Qty",      fmt: "number" },
  { key: "opt_entry_price",    label: "Opt Entry Price",    fmt: "currency" },
  { key: "opt_exit_price",     label: "Opt Exit Price",     fmt: "currency" },
  { key: "fut_qty",            label: "Fut Qty",            fmt: "number" },
  { key: "fut_entry_price",    label: "Fut Entry Price",    fmt: "currency" },
  { key: "fut_exit_price",     label: "Fut Exit Price",     fmt: "currency" },
  { key: "upside_distance",    label: "Upside Distance",    fmt: "number" },
  { key: "down_distance",      label: "Down Distance",      fmt: "number" },
  { key: "basket_distance",    label: "Basket Distance",    fmt: "number" },
  { key: "basket_loss",        label: "Basket Loss",        fmt: "currency" },
  { key: "total_baskets",      label: "Total Baskets",      fmt: "number" },
  { key: "total_mm_loss",      label: "Total MM Loss",      fmt: "currency" },
  { key: "net_booked_pnl",     label: "Net Booked PNL",     fmt: "currency" },
  { key: "market_making_pl",   label: "Market Making PL",   fmt: "currency" },
];

/* ── Bot param fields to display for best-day entry ──── */
const BOT_PARAM_FIELDS = [
  { key: "investment",             label: "Investment",            fmt: "currency" },
  { key: "entry_futures",          label: "Entry Futures",         fmt: "currency" },
  { key: "entry_futures_price",    label: "Entry Futures Price",   fmt: "currency" },
  { key: "bot_entry_price",        label: "Bot Entry Price",       fmt: "currency" },
  { key: "market_making_qty",      label: "Market Making Qty",     fmt: "number" },
  { key: "average_spread",         label: "Average Spread",        fmt: "percent" },
  { key: "target_spread",          label: "Target Spread",         fmt: "percent" },
  { key: "basket_distance",        label: "Basket Distance",       fmt: "percent" },
  { key: "total_distance",         label: "Total Distance",        fmt: "percent" },
  { key: "total_steps",            label: "Total Steps",           fmt: "number" },
  { key: "per_step_qty",           label: "Per Step Qty",          fmt: "number" },
  { key: "rtp_value",              label: "RTP Value",             fmt: "number" },
  { key: "total_baskets_one_side", label: "Total Baskets (1 Side)",fmt: "number" },
  { key: "basket_loss",            label: "Basket Loss",           fmt: "currency" },
  { key: "total_baskets",          label: "Total Baskets",         fmt: "number" },
  { key: "daily_loss",             label: "Daily Loss",            fmt: "currency" },
  { key: "basket_max_qty",         label: "Basket Max Qty",        fmt: "number" },
  { key: "upper_limit",            label: "Upper Limit",           fmt: "currency" },
  { key: "lower_limit",            label: "Lower Limit",           fmt: "currency" },
];

const BOT_PERF_FIELDS = [
  { key: "rtps",          label: "RTPS",           fmt: "number" },
  { key: "rtp_pnl",       label: "RTP PNL",        fmt: "currency" },
  { key: "per_hour_rtps", label: "Per Hour RTPS",  fmt: "number" },
  { key: "rebates",       label: "Rebates",        fmt: "currency" },
  { key: "flatten_pnl",   label: "Flatten PNL",    fmt: "currency" },
  { key: "gamma_booked",  label: "Gamma Booked",   fmt: "currency" },
  { key: "net_pnl",       label: "Net PNL",        fmt: "currency" },
  { key: "volume",        label: "Volume",         fmt: "currency" },
  { key: "apy",           label: "APY",            fmt: "percent" },
];

/* ── Page ────────────────────────────────────────────────── */
export default function OptionsAnalysis() {
  const [allTrades,       setAllTrades]       = useState([]);
  const [selectedId,      setSelectedId]      = useState("");
  const [trade,           setTrade]           = useState(null);
  const [loadingList,     setLoadingList]     = useState(true);
  const [loadingTrade,    setLoadingTrade]    = useState(false);
  const [error,           setError]           = useState(null);

  const [activeTab,      setActiveTab]      = useState("analysis");

  const [filterToken,    setFilterToken]    = useState("all");
  const [filterStatus,   setFilterStatus]   = useState("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo,   setFilterDateTo]   = useState("");

  // Cumulative report
  const [cumFrom,    setCumFrom]    = useState("");
  const [cumTo,      setCumTo]      = useState("");
  const [cumSymbol,  setCumSymbol]  = useState("all");
  const [cumAccount, setCumAccount] = useState("all");
  const [cumBot,     setCumBot]     = useState(null);
  const [cumOpts,    setCumOpts]    = useState([]);
  const [loadingCum, setLoadingCum] = useState(false);

  const [accounts,        setAccounts]        = useState([]);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [botData,         setBotData]         = useState(null);
  const [loadingBot,      setLoadingBot]      = useState(false);

  useEffect(() => {
    fetch("/api/options/trades?limit=9999")
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setAllTrades(j.trades || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    fetch("/api/bot-period-summary")
      .then((r) => r.json())
      .then((j) => setAccounts(j.accounts || []))
      .catch(() => {});
  }, []);

  // Show only base symbols: ETH, BTC, SOL (first segment before "-")
  const symbols = useMemo(() => {
    const s = new Set(allTrades.map((t) => baseToken(t.token)).filter(Boolean));
    return [...s].sort();
  }, [allTrades]);

  const filteredTrades = useMemo(() => {
    return allTrades.filter((t) => {
      if (filterToken  !== "all" && baseToken(t.token) !== filterToken) return false;
      if (filterStatus !== "all" && t.status !== filterStatus) return false;
      const d = t.entry_date ? toLocalDateStr(t.entry_date) : null;
      const validDate = d && d !== "0000-00-00";
      if (filterDateFrom && validDate && d < filterDateFrom) return false;
      if (filterDateTo   && validDate && d > filterDateTo)   return false;
      return true;
    });
  }, [allTrades, filterToken, filterStatus, filterDateFrom, filterDateTo]);

  useEffect(() => {
    if (selectedId && !filteredTrades.find((t) => String(t.id) === String(selectedId))) {
      setSelectedId("");
    }
  }, [filteredTrades, selectedId]);

  useEffect(() => {
    if (!selectedId) { setTrade(null); setBotData(null); setSelectedAccount(""); return; }
    setLoadingTrade(true);
    fetch(`/api/options/trades/${selectedId}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setTrade(j.trade); setBotData(null); setSelectedAccount(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingTrade(false));
  }, [selectedId]);

  useEffect(() => {
    if (!trade || !selectedAccount) { setBotData(null); return; }
    const df = trade.entry_date ? toLocalDateStr(trade.entry_date) : null;
    const dt = trade.end_date   ? toLocalDateStr(trade.end_date)   : null;
    if (!df || !dt) { setBotData(null); return; }
    setLoadingBot(true);
    const p = new URLSearchParams({ date_from: df, date_to: dt, account: selectedAccount });
    fetch(`/api/bot-period-summary?${p}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setBotData(j); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingBot(false));
  }, [trade, selectedAccount]);

  function loadCumulative() {
    if (!cumFrom || !cumTo) return;
    setLoadingCum(true);
    setCumBot(null);
    const p = new URLSearchParams({ date_from: cumFrom, date_to: cumTo });
    if (cumAccount !== "all") p.set("account", cumAccount);
    if (cumSymbol  !== "all") p.set("symbol",  cumSymbol);
    fetch(`/api/cumulative-report?${p}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setCumBot(j); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingCum(false));
    // Options: filter allTrades client-side
    const opts = allTrades.filter((t) => {
      const d = t.entry_date ? toLocalDateStr(t.entry_date) : null;
      if (!d || d === "0000-00-00") return false;
      if (d < cumFrom || d > cumTo) return false;
      if (cumSymbol !== "all" && baseToken(t.token) !== cumSymbol) return false;
      return true;
    });
    setCumOpts(opts);
  }

  /* Derived */
  const dateFrom = trade?.entry_date ? toLocalDateStr(trade.entry_date) : null;
  const dateTo   = trade?.end_date   ? toLocalDateStr(trade.end_date)   : null;

  // Fix: use local date (not toISOString) to avoid UTC timezone shift
  const runningDates = useMemo(() => {
    if (!dateFrom || !dateTo) return [];
    const dates = [];
    const start = new Date(dateFrom + "T00:00:00");
    const end   = new Date(dateTo   + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(localIso(d));
    }
    return dates;
  }, [dateFrom, dateTo]);

  const numDays     = runningDates.length;
  const optionPnl   = Number(trade?.net_booked_pnl || 0);
  const botNetPnl   = Number(botData?.summary?.net_pnl || 0);
  const combinedPnl = optionPnl + botNetPnl;
  const hasFilters  = filterToken !== "all" || filterStatus !== "all" || filterDateFrom || filterDateTo || selectedAccount;

  // Per-day map (date string → day row)
  const dayMap = useMemo(() => {
    const m = new Map();
    (botData?.dayBreakdown || []).forEach((d) => {
      const key = toLocalDateStr(d.date);
      if (key) m.set(key, d);
    });
    return m;
  }, [botData]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6">
        <div className="flex h-16 items-center justify-between">
          <h1 className="text-lg font-bold text-slate-800">Options &amp; RTPS Analysis</h1>
          <Link href="/options" className="text-sm text-slate-500 hover:text-slate-700">← All Strategies</Link>
        </div>
        <div className="flex gap-1 -mb-px">
          {[["analysis","Strategy Analysis"],["cumulative","Cumulative Report"]].map(([key,label]) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors ${activeTab === key ? "border-teal-600 text-teal-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="p-6 space-y-5">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* ── Strategy Analysis Tab ─────────────────────────── */}
        {activeTab === "analysis" && (<>

        {/* ── Strategy Selector ─────────────────────────────── */}
        <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Symbol</label>
              <select value={filterToken} onChange={(e) => setFilterToken(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="all">All Symbols</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Status</label>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="all">All Status</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Bot Account</label>
              <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                <option value="">All Accounts</option>
                {accounts.map((a) => <option key={a.token_name} value={a.token_name}>{a.token_name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Entry Date From</label>
              <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Entry Date To</label>
              <div className="flex gap-2">
                <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                {hasFilters && (
                  <button onClick={() => { setFilterToken("all"); setFilterStatus("all"); setFilterDateFrom(""); setFilterDateTo(""); setSelectedAccount(""); }}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50">
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-slate-700">
              Select Strategy
              {filteredTrades.length > 0 && <span className="ml-2 text-xs font-normal text-slate-400">({filteredTrades.length} found)</span>}
            </label>
            {loadingList ? (
              <p className="text-sm text-slate-400">Loading strategies…</p>
            ) : filteredTrades.length === 0 ? (
              <p className="text-sm text-amber-600">
                {allTrades.length === 0
                  ? <>No strategies yet — add one from the <Link href="/options" className="underline font-medium">dashboard</Link>.</>
                  : "No strategies match the selected filters."}
              </p>
            ) : (
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:border-brand focus:outline-none">
                <option value="">— Select a strategy —</option>
                {filteredTrades.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.id} · {t.token} · {t.option_type} · {fmtDate(t.entry_date)} → {fmtDate(t.end_date)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {loadingTrade && <p className="text-sm text-slate-400">Loading strategy…</p>}

        {/* ── Analysis Body ─────────────────────────────────── */}
        {trade && (
          <div className="space-y-5">

            {/* Header 2-cards */}
            <div className="grid grid-cols-2 gap-4">
              <HeaderCard label="DATE" value={fmt(trade.entry_date)}><CalIcon /></HeaderCard>
              <HeaderCard label="TOKEN" value={baseToken(trade.token)} large>
                <TokenBadge token={baseToken(trade.token)} />
              </HeaderCard>
            </div>

            {/* Strategy dates */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Running days (with per-day metrics if bot loaded) */}
              <div className="rounded-xl border border-teal-100 bg-white p-5 shadow-card">
                <div className="flex items-center gap-2 mb-4">
                  <span className="h-8 w-8 rounded-lg bg-teal-50 flex items-center justify-center"><CalIcon sm /></span>
                  <h3 className="text-sm font-bold text-teal-700 uppercase tracking-wide">Strategy Running Days</h3>
                </div>
                {runningDates.length === 0 ? (
                  <p className="text-sm text-slate-400">Set entry date and end date to see running days.</p>
                ) : botData ? (
                  /* Table layout */
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="py-2 pr-4 text-left text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Date</th>
                          <th className="py-2 px-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">RTPS</th>
                          <th className="py-2 px-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Net PNL</th>
                          <th className="py-2 px-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Rebates</th>
                          <th className="py-2 px-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Flatten</th>
                          <th className="py-2 px-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">Vol</th>
                          <th className="py-2 pl-3 text-right text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap">RTP PNL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runningDates.map((d) => {
                          const day = dayMap.get(d);
                          return (
                            <tr key={d} className="border-b border-dashed border-slate-100 last:border-0 hover:bg-slate-50/60">
                              <td className="py-2.5 pr-4 whitespace-nowrap">
                                <span className="text-sm font-bold text-teal-700">{fmt(d)}</span>
                              </td>
                              {day ? (
                                <>
                                  <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtNum(day.rtps)}</td>
                                  <td className={`py-2.5 px-3 text-right text-sm font-semibold whitespace-nowrap ${Number(day.net_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(day.net_pnl)}</td>
                                  <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(day.rebates)}</td>
                                  <td className={`py-2.5 px-3 text-right text-sm font-semibold whitespace-nowrap ${Number(day.flatten_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(day.flatten_pnl)}</td>
                                  <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtVol(day.volume)}</td>
                                  <td className="py-2.5 pl-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(day.rtp_pnl)}</td>
                                </>
                              ) : (
                                <td colSpan={6} className="py-2.5 px-3 text-xs text-slate-400 italic">No bot data</td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  /* Simple chips before account selected */
                  <div className="flex flex-wrap gap-2">
                    {runningDates.map((d) => (
                      <span key={d} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-700">
                        {fmt(d)}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Option entry / exit */}
              <div className="rounded-xl border border-teal-100 bg-white p-5 shadow-card space-y-5">
                <div className="flex items-center gap-3">
                  <span className="h-9 w-9 rounded-lg bg-teal-50 flex items-center justify-center shrink-0"><CalIcon sm /></span>
                  <div>
                    <p className="text-xs font-bold text-teal-600 uppercase tracking-wide">Option Entry Date</p>
                    <p className="text-xl font-bold text-slate-800">{fmt(trade.entry_date)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="h-9 w-9 rounded-lg bg-teal-50 flex items-center justify-center shrink-0"><CalIcon sm /></span>
                  <div>
                    <p className="text-xs font-bold text-teal-600 uppercase tracking-wide">Option Exit Date</p>
                    <p className="text-xl font-bold text-slate-800">{fmt(trade.end_date)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Payoff Chart */}
            {trade.options_strike && (
              <PayoffChart trade={trade} />
            )}

            {/* Bot section */}
            {!selectedAccount ? (
              <div className="rounded-xl border border-teal-100 bg-teal-50 px-5 py-4 text-center text-sm text-teal-700 font-medium">
                Select an account above to load bot metrics and see combined PNL.
              </div>
            ) : loadingBot ? (
              <div className="rounded-xl border border-slate-100 bg-white p-6 text-center text-sm text-slate-400">
                Loading bot metrics for <strong>{selectedAccount}</strong>…
              </div>
            ) : !botData?.summary?.entry_count ? (
              <div className="rounded-xl border border-amber-100 bg-amber-50 px-5 py-4 text-center text-sm text-amber-700">
                No bot entries found for <strong>{selectedAccount}</strong> between {fmt(dateFrom)} and {fmt(dateTo)}.
              </div>
            ) : (
              <>
                {/* Bot metrics row */}
                <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">
                    Bot Metrics — {selectedAccount} · {fmt(dateFrom)} → {fmt(dateTo)}
                  </p>
                  <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
                    <BotBox label="RTPS"          sub="Per-RTP"    value={fmtNum(botData.summary.rtps)} />
                    <BotBox label="Per Hour RTPS" sub="Avg/Hr"     value={fmtNum(botData.summary.per_hour_rtps)} />
                    <BotBox label="Rebates"       sub="Total"      value={fmtCcy(botData.summary.rebates)} />
                    <BotBox label="Flatten PNL"   sub="Total"      value={fmtCcy(botData.summary.flatten_pnl)} signed />
                    <BotBox label="Net PNL"       sub="Total"      value={fmtCcy(botData.summary.net_pnl)} signed />
                    <BotBox label="Volume"        sub="Total"      value={fmtVol(botData.summary.volume)} />
                    <BotBox label="APY"           sub="Annualised" value={botData.summary.apy != null ? `${Number(botData.summary.apy).toFixed(2)}%` : "—"} />
                  </div>
                </div>

                {/* Highlight cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-teal-200 bg-white p-5 shadow-card flex items-center gap-4">
                    <div className="h-14 w-14 rounded-xl bg-teal-50 flex items-center justify-center shrink-0">
                      <svg className="h-7 w-7 text-teal-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12V7H5a2 2 0 010-4h14v4" strokeLinecap="round"/>
                        <path d="M3 5v14a2 2 0 002 2h16v-5" strokeLinecap="round"/>
                        <path d="M18 12a2 2 0 000 4h4v-4z"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-teal-600 uppercase tracking-wide">Option Booked PNL</p>
                      <p className="text-xs text-slate-400 mt-0.5">OPTION · BOOKED PNL</p>
                      <p className={`text-2xl font-extrabold mt-1 ${optionPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(optionPnl)}</p>
                    </div>
                  </div>
                  <div className="rounded-xl border border-indigo-200 bg-white p-5 shadow-card flex items-center gap-4">
                    <div className="h-14 w-14 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
                      <svg className="h-7 w-7 text-indigo-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="3" width="20" height="14" rx="2"/>
                        <path d="M8 21h8M12 17v4" strokeLinecap="round"/>
                        <path d="M7 8l3 3 2-2 3 3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-indigo-600 uppercase tracking-wide">RTPS ({numDays} Day Bot)</p>
                      <p className="text-xs text-slate-400 mt-0.5">{numDays} DAY BOT · NET PNL</p>
                      <p className="text-base font-semibold text-slate-700 mt-1">RTPS: {fmtNum(botData.summary.rtps)}</p>
                      <p className={`text-base font-bold ${botNetPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>Net PNL: {fmtCcy(botNetPnl)}</p>
                    </div>
                  </div>
                </div>

                {/* Combined PNL */}
                <div className="rounded-xl border-2 border-teal-200 bg-white py-6 px-8 shadow-card">
                  <div className="flex items-center gap-4">
                    <div className="h-px flex-1 bg-teal-100" />
                    <div className="text-center">
                      <svg className="h-9 w-9 text-teal-600 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 3v18h18" strokeLinecap="round"/>
                        <path d="M7 16l4-4 4 4 4-6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <p className="text-sm font-bold text-teal-700 uppercase tracking-widest">Combined Net PNL</p>
                      <p className={`text-4xl font-extrabold mt-1 ${combinedPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {fmtCcy(combinedPnl)}
                      </p>
                      <p className="text-xs text-slate-400 mt-2">Option {fmtCcy(optionPnl)} + Bot {fmtCcy(botNetPnl)}</p>
                    </div>
                    <div className="h-px flex-1 bg-teal-100" />
                  </div>
                </div>

                {/* Details columns */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Option Details — full input */}
                  <div className="rounded-xl border border-teal-100 bg-white p-5 shadow-card">
                    <SecHead color="teal" title="Option Details" icon="doc" />
                    <div className="mt-4">
                      {OPT_FIELDS.map(({ key, label, fmt: f }) => {
                        const raw = trade[key];
                        let val;
                        if (f === "date") val = fmt(raw);
                        else if (f === "currency") val = fmtCcy(raw);
                        else if (f === "number") val = fmtNum(raw, 4);
                        else val = raw != null && raw !== "" ? String(raw) : "—";
                        const colored = f === "currency" && (key === "net_booked_pnl" || key === "market_making_pl");
                        return <DRow key={key} label={label} value={val} colored={colored} />;
                      })}
                    </div>
                  </div>

                  {/* Bot Details — best-day entries */}
                  <div className="space-y-4">
                    {/* Best PNL day */}
                    {botData.bestPnlEntry && (
                      <div className="rounded-xl border border-indigo-100 bg-white p-5 shadow-card">
                        <SecHead color="indigo" title={`Highest PNL Day — ${fmt(botData.bestPnlEntry.entry_datetime)}`} icon="bot" />
                        <div className="mt-4">
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Performance</p>
                          {BOT_PERF_FIELDS.map(({ key, label, fmt: f }) => {
                            const raw = botData.bestPnlEntry[key];
                            const val = fmtVal(raw, f);
                            const colored = f === "currency" && (key === "net_pnl" || key === "flatten_pnl" || key === "rtp_pnl");
                            return <DRow key={key} label={label} value={val} colored={colored} />;
                          })}
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mt-4 mb-2">Bot Input Parameters</p>
                          {BOT_PARAM_FIELDS.map(({ key, label, fmt: f }) => {
                            const raw = botData.bestPnlEntry[key];
                            if (raw === null || raw === undefined || raw === "") return null;
                            return <DRow key={key} label={label} value={fmtVal(raw, f)} />;
                          })}
                        </div>
                      </div>
                    )}

                    {/* Best RTPS day (only if different from best PNL day) */}
                    {botData.bestRtpsEntry &&
                      botData.bestPnlEntry?.id !== botData.bestRtpsEntry?.id && (
                      <div className="rounded-xl border border-purple-100 bg-white p-5 shadow-card">
                        <SecHead color="purple" title={`Highest RTPS Day — ${fmt(botData.bestRtpsEntry.entry_datetime)}`} icon="rtps" />
                        <div className="mt-4">
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Performance</p>
                          {BOT_PERF_FIELDS.map(({ key, label, fmt: f }) => {
                            const raw = botData.bestRtpsEntry[key];
                            const val = fmtVal(raw, f);
                            const colored = f === "currency" && (key === "net_pnl" || key === "flatten_pnl" || key === "rtp_pnl");
                            return <DRow key={key} label={label} value={val} colored={colored} />;
                          })}
                          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mt-4 mb-2">Bot Input Parameters</p>
                          {BOT_PARAM_FIELDS.map(({ key, label, fmt: f }) => {
                            const raw = botData.bestRtpsEntry[key];
                            if (raw === null || raw === undefined || raw === "") return null;
                            return <DRow key={key} label={label} value={fmtVal(raw, f)} />;
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        </>)}

        {/* ── Cumulative Report Tab ─────────────────────────── */}
        {activeTab === "cumulative" && (
          <div className="space-y-5">
            {/* Filters + date range */}
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
              <h2 className="text-sm font-bold text-slate-700 mb-4">Select Date Range &amp; Filters</h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Symbol</label>
                  <select value={cumSymbol} onChange={(e) => setCumSymbol(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                    <option value="all">All Symbols</option>
                    {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Account</label>
                  <select value={cumAccount} onChange={(e) => setCumAccount(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                    <option value="all">All Accounts</option>
                    {accounts.map((a) => <option key={a.token_name} value={a.token_name}>{a.token_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">From</label>
                  <input type="date" value={cumFrom} onChange={(e) => setCumFrom(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">To</label>
                  <input type="date" value={cumTo} onChange={(e) => setCumTo(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                </div>
                <div className="flex items-end">
                  <button onClick={loadCumulative} disabled={!cumFrom || !cumTo || loadingCum}
                    className="w-full rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
                    {loadingCum ? "Loading…" : "Load Report"}
                  </button>
                </div>
              </div>
            </div>

            {/* Results */}
            {cumBot && (() => {
              // Aggregate options PNL by base token
              const optByToken = {};
              cumOpts.forEach((t) => {
                const sym = baseToken(t.token);
                if (!optByToken[sym]) optByToken[sym] = 0;
                optByToken[sym] += Number(t.net_booked_pnl || 0);
              });
              const totalOptPnl = Object.values(optByToken).reduce((a, b) => a + b, 0);

              return (
                <>
                  {/* Summary banner */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <SummaryCard label="Bot Net PNL" value={fmtCcy(cumBot.totals.net_pnl)} colored />
                    <SummaryCard label="Options PNL" value={fmtCcy(totalOptPnl)} colored />
                    <SummaryCard label="Combined PNL" value={fmtCcy(cumBot.totals.net_pnl + totalOptPnl)} colored big />
                    <SummaryCard label="Bot RTP PNL" value={fmtCcy(cumBot.totals.rtp_pnl)} />
                  </div>

                  {/* Per-account bot table */}
                  <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
                    <h3 className="text-sm font-bold text-slate-700 mb-4">
                      Bot Performance by Account
                      <span className="ml-2 text-xs font-normal text-slate-400">{fmt(cumFrom)} → {fmt(cumTo)}</span>
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200">
                            {["Account","Symbol","RTPS","Net PNL","RTP PNL","Rebates","Flatten","Volume","Days"].map((h) => (
                              <th key={h} className={`py-2 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap ${h === "Account" || h === "Symbol" ? "text-left" : "text-right"}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {cumBot.rows.map((r) => (
                            <tr key={r.token_name} className="border-b border-dashed border-slate-100 last:border-0 hover:bg-slate-50/60">
                              <td className="py-2.5 px-3 text-sm font-semibold text-teal-700 whitespace-nowrap">{r.token_name}</td>
                              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.token_symbol}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtNum(r.rtps)}</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-bold whitespace-nowrap ${Number(r.net_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(r.net_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(r.rtp_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(r.rebates)}</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-semibold whitespace-nowrap ${Number(r.flatten_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(r.flatten_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtVol(r.volume)}</td>
                              <td className="py-2.5 px-3 text-right text-sm text-slate-500 whitespace-nowrap">{r.active_days}</td>
                            </tr>
                          ))}
                          {/* Totals row */}
                          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                            <td className="py-2.5 px-3 text-sm text-slate-700" colSpan={2}>TOTAL</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-500">—</td>
                            <td className={`py-2.5 px-3 text-right text-sm font-bold ${cumBot.totals.net_pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(cumBot.totals.net_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtCcy(cumBot.totals.rtp_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtCcy(cumBot.totals.rebates)}</td>
                            <td className={`py-2.5 px-3 text-right text-sm font-bold ${cumBot.totals.flatten_pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(cumBot.totals.flatten_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtVol(cumBot.totals.volume)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-500">—</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Options PNL by token */}
                  {cumOpts.length > 0 && (
                    <div className="rounded-xl border border-teal-100 bg-white p-5 shadow-card">
                      <h3 className="text-sm font-bold text-slate-700 mb-4">
                        Options PNL by Token
                        <span className="ml-2 text-xs font-normal text-slate-400">{cumOpts.length} strategies</span>
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                            <tr className="border-b border-slate-200">
                              {["Token","Strategies","Net Booked PNL"].map((h) => (
                                <th key={h} className={`py-2 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap ${h === "Token" ? "text-left" : "text-right"}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(optByToken).sort((a,b) => b[1]-a[1]).map(([sym, pnl]) => (
                              <tr key={sym} className="border-b border-dashed border-slate-100 last:border-0 hover:bg-slate-50/60">
                                <td className="py-2.5 px-3 text-sm font-semibold text-teal-700">{sym}</td>
                                <td className="py-2.5 px-3 text-right text-sm text-slate-600">{cumOpts.filter(t => baseToken(t.token) === sym).length}</td>
                                <td className={`py-2.5 px-3 text-right text-sm font-bold ${pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(pnl)}</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                              <td className="py-2.5 px-3 text-sm text-slate-700" colSpan={2}>TOTAL</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-bold ${totalOptPnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(totalOptPnl)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────── */

function HeaderCard({ label, value, large, children }) {
  return (
    <div className="rounded-xl border border-teal-100 bg-white p-4 shadow-card flex items-center gap-3">
      <span className="h-10 w-10 rounded-xl bg-teal-50 flex items-center justify-center shrink-0">{children}</span>
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
        <p className={`font-bold text-slate-800 ${large ? "text-2xl" : "text-base"}`}>{value}</p>
      </div>
    </div>
  );
}

function SecHead({ color, title, icon }) {
  const ring = { teal: "bg-teal-50", indigo: "bg-indigo-50", purple: "bg-purple-50" }[color];
  const txt  = { teal: "text-teal-600", indigo: "text-indigo-600", purple: "text-purple-600" }[color];
  const ttxt = { teal: "text-teal-700", indigo: "text-indigo-700", purple: "text-purple-700" }[color];
  return (
    <div className="flex items-center gap-2">
      <span className={`h-8 w-8 rounded-lg ${ring} flex items-center justify-center shrink-0`}>
        {icon === "doc" ? (
          <svg className={`h-4 w-4 ${txt}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round"/>
          </svg>
        ) : icon === "rtps" ? (
          <svg className={`h-4 w-4 ${txt}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 17l4-8 4 4 4-6 4 4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ) : (
          <svg className={`h-4 w-4 ${txt}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <path d="M8 21h8M12 17v4" strokeLinecap="round"/>
          </svg>
        )}
      </span>
      <h3 className={`text-sm font-bold ${ttxt}`}>{title}</h3>
    </div>
  );
}

function BotBox({ label, sub, value, signed }) {
  const isNeg = signed && typeof value === "string" && value.startsWith("-");
  return (
    <div className="flex flex-col items-center text-center gap-1 rounded-lg bg-slate-50 p-3">
      <p className="text-xs font-bold text-teal-600 leading-tight">{label}</p>
      <p className="text-[10px] text-slate-400 leading-tight">{sub}</p>
      <p className={`text-sm font-extrabold ${isNeg ? "text-red-600" : "text-slate-800"}`}>{value}</p>
    </div>
  );
}

function DRow({ label, value, colored }) {
  const isNeg = colored && typeof value === "string" && value.startsWith("-");
  const valCls = colored ? (isNeg ? "text-red-600" : "text-emerald-600") : "text-slate-800";
  return (
    <div className="flex items-center justify-between py-2 border-b border-dashed border-slate-100 last:border-0">
      <span className="text-sm text-slate-500 truncate pr-2">{label}</span>
      <span className={`text-sm font-semibold shrink-0 ${valCls}`}>{value}</span>
    </div>
  );
}

function DayKV({ label, value, colored }) {
  const isNeg = colored && typeof value === "string" && value.startsWith("-");
  return (
    <div>
      <p className="text-[10px] text-slate-400 leading-tight">{label}</p>
      <p className={`text-xs font-bold ${colored ? (isNeg ? "text-red-600" : "text-emerald-600") : "text-slate-700"}`}>{value}</p>
    </div>
  );
}

function CalIcon({ sm }) {
  const cls = sm ? "h-4 w-4 text-teal-600" : "h-5 w-5 text-teal-600";
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round"/>
    </svg>
  );
}

function SummaryCard({ label, value, colored, big }) {
  const isNeg = colored && typeof value === "string" && value.startsWith("-");
  const valCls = colored ? (isNeg ? "text-red-600" : "text-emerald-600") : "text-slate-800";
  return (
    <div className={`rounded-xl border bg-white p-4 shadow-card ${big ? "border-teal-200" : "border-slate-100"}`}>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`font-extrabold ${big ? "text-2xl" : "text-xl"} ${valCls}`}>{value}</p>
    </div>
  );
}

function TokenBadge({ token }) {
  const COLORS = ["bg-blue-500","bg-purple-500","bg-emerald-500","bg-orange-500","bg-pink-500"];
  const idx = (token || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length;
  return (
    <div className={`h-8 w-8 rounded-full ${COLORS[idx]} text-white flex items-center justify-center text-xs font-bold`}>
      {(token || "??").slice(0, 2).toUpperCase()}
    </div>
  );
}

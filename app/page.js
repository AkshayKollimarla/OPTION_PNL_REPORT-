"use client";

import { useEffect, useState, useCallback } from "react";
import MetricCard from "../components/MetricCard";
import {
  METRIC_CARDS,
  BOT_DETAILS_LEFT,
  BOT_DETAILS_RIGHT,
  formatValue,
} from "../lib/fields";

// Keys that are summed across a date range
const SUM_KEYS = new Set(["rtps", "rtp_pnl", "rebates", "gamma_booked", "flatten_pnl", "net_pnl", "volume"]);

// Aggregate multiple entries into one display object
function summarize(entries) {
  if (!entries.length) return null;
  if (entries.length === 1) return { ...entries[0], _isSummary: false, _count: 1 };

  // entries are sorted DESC — oldest is last
  const latest = entries[0];
  const oldest = entries[entries.length - 1];
  const result = { ...latest };

  // SUM fields
  for (const key of SUM_KEYS) {
    result[key] = entries.reduce((acc, e) => acc + Number(e[key] || 0), 0);
  }

  // Per Hour RTPS = average (sum / count)
  const phSum = entries.reduce((acc, e) => acc + Number(e.per_hour_rtps || 0), 0);
  result.per_hour_rtps = phSum / entries.length;

  // Which tokens actually went into this total. Without it the Token card
  // shows whichever coin happened to be newest, which reads as though the
  // whole summary belonged to that one coin.
  result._tokens = [...new Set(entries.map((e) => e.token_symbol).filter(Boolean))];

  // Capital backing the total. Investments are per-entry snapshots of the same
  // capital, so they average rather than sum — adding 193 daily rows would
  // count the same money 193 times.
  const invEntries = entries.filter((e) => Number(e.investment) > 0);
  const avgInvestment = invEntries.length
    ? invEntries.reduce((acc, e) => acc + Number(e.investment), 0) / invEntries.length
    : 0;
  result._avgInvestment = avgInvestment;

  // Days actually covered, inclusive, so a one-day range is 1 and not 0.
  const msPerDay = 86400000;
  const spanDays = Math.max(
    1,
    Math.round((new Date(latest.entry_datetime) - new Date(oldest.entry_datetime)) / msPerDay) + 1
  );
  result._days = spanDays;

  // Annualise over the period the entries actually cover. The old form
  // multiplied the whole range's P&L by 365 as if it had been earned in a
  // single day, which was survivable while summaries were opt-in but reads as
  // a five-figure APY now that the unfiltered dashboard is a summary.
  result.apy = avgInvestment
    ? (result.net_pnl / avgInvestment) * (365 / spanDays) * 100
    : 0;

  result._isSummary = true;
  result._count = entries.length;
  result._dateFrom = oldest.entry_datetime;
  result._dateTo = latest.entry_datetime;

  return result;
}

export default function Dashboard() {
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [symbol, setSymbol] = useState("");
  const [symbols, setSymbols] = useState([]);
  const [account, setAccount] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [exchange, setExchange] = useState("");
  const [exchanges, setExchanges] = useState([]);
  // symbol -> exchange / account -> exchange, so picking an exchange can
  // narrow the other two dropdowns without another round trip.
  const [symbolExchange, setSymbolExchange] = useState({});
  const [accountExchange, setAccountExchange] = useState({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [truncated, setTruncated] = useState(false);
  // Booked P&L from the options book, aggregated server-side.
  const [optionsPnl, setOptionsPnl] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (symbol) qs.set("symbol", symbol);
      if (account) qs.set("account", account);
      if (exchange) qs.set("exchange", exchange);
      if (from) qs.set("from", from);
      if (to)   qs.set("to", to);
      // Single date selected: treat as exact day (from 00:00 to 23:59)
      if (from && !to) qs.set("to", from);
      // The cards aggregate whatever comes back, so ask for the full history
      // rather than the default page. `truncated` below reports honestly if
      // even this is not everything.
      qs.set("limit", "1000");
      const res = await fetch(`/api/entries?${qs.toString()}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      const entries = json.entries || [];
      // Always aggregate the matching set. Previously this summarised only
      // when BOTH dates were set, so the unfiltered dashboard showed a single
      // newest row — one coin's numbers presented as if they were the whole
      // account. summarize() returns the row unchanged when there is only one.
      setEntry(summarize(entries));
      setTruncated(!!json.truncated);
      setSymbols(json.symbols || []);
      setAccounts(json.accounts || []);
      setExchanges(json.exchanges || []);
      setSymbolExchange(json.symbolExchange || {});
      setAccountExchange(json.accountExchange || {});

      // Options strategies live in their own database with their own token and
      // account naming, so only the date range carries across cleanly. Symbol
      // and account are deliberately not forwarded: "SOL-USDC-PERPETUAL" here
      // is "SOL_USDC" there, and a near-miss would silently read as zero.
      const oq = new URLSearchParams();
      if (from) oq.set("from", from);
      if (from || to) oq.set("to", to || from);
      const ores = await fetch(`/api/options/pnl-summary?${oq.toString()}`, { cache: "no-store" });
      setOptionsPnl(ores.ok ? await ores.json() : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [symbol, account, exchange, from, to]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const e = entry || {};
  const isSummary = !!e._isSummary;

  return (
    <div>
      <Header />

      <div className="p-6 space-y-6">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {!entry && !loading && !error && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No entries yet. Go to <strong>Manual Entry</strong> in the sidebar to add your first record.
          </div>
        )}

        {truncated && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            More than 1,000 entries match this filter. The totals below cover the
            1,000 most recent only — narrow the date range for exact figures.
          </div>
        )}

        {/* Top cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {/* Date card — shows range when summarising */}
          <InfoCard
            label="Date"
            big={
              isSummary
                ? formatDate(e._dateFrom)
                : e.entry_datetime
                ? formatDate(e.entry_datetime)
                : "—"
            }
            small={
              isSummary
                ? `→ ${formatDate(e._dateTo)}`
                : e.entry_datetime
                ? formatTime(e.entry_datetime)
                : ""
            }
            boldSmall={isSummary}
            icon="📅"
          />

          {/* Token card */}
          <InfoCard
            label={isSummary ? "Tokens" : "Token Name"}
            big={
              isSummary
                ? `${(e._tokens || []).length} token${(e._tokens || []).length === 1 ? "" : "s"}`
                : e.token_name || "—"
            }
            small={isSummary ? (e._tokens || []).join(", ") : e.token_symbol || ""}
            icon="◎"
          />

          {/* Investment card */}
          <InfoCard
            label="Investment"
            big={
              isSummary
                ? e._avgInvestment
                  ? formatValue(e._avgInvestment, "currency")
                  : "—"
                : e.investment != null && e.investment !== ""
                ? formatValue(e.investment, "currency")
                : "—"
            }
            small={isSummary ? "avg per entry" : ""}
            icon="💰"
          />

          {/* Options P&L — the options strategy book, not the grid bot */}
          <MetricCard
            label="Options PnL"
            value={optionsPnl ? optionsPnl.bookedPnl : null}
            format="currency"
            color="teal"
            signAware
            sub={
              optionsPnl
                ? `${optionsPnl.closedCount} closed${optionsPnl.openCount ? ` · ${optionsPnl.openCount} open` : ""}`
                : ""
            }
          />

          {METRIC_CARDS.map((f) => (
            <MetricCard
              key={f.key}
              label={f.label}
              value={e[f.key]}
              format={f.format}
              color={f.color}
              signAware={f.key === "flatten_pnl"}
            />
          ))}
        </div>

        {/* Filter bar */}
        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 items-end">
            <Field label="Exchange">
              <select
                value={exchange}
                onChange={(e) => {
                  const next = e.target.value;
                  setExchange(next);
                  // Drop a symbol/account that does not belong to the new
                  // exchange, otherwise the two filters contradict and the
                  // result is silently empty.
                  if (next && symbol && symbolExchange[symbol] !== next) setSymbol("");
                  if (next && account && accountExchange[account] !== next) setAccount("");
                }}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              >
                <option value="">All exchanges</option>
                {exchanges.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Symbol">
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              >
                <option value="">All symbols</option>
                {symbols.filter((s) => !exchange || symbolExchange[s] === exchange).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Account">
              <select
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              >
                <option value="">All accounts</option>
                {accounts.filter((a) => !exchange || accountExchange[a] === exchange).map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </Field>
            <Field label="From Date">
              <input
                type="date"
                value={from}
                onChange={(ev) => setFrom(ev.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
            </Field>
            <Field label="To Date">
              <input
                type="date"
                value={to}
                onChange={(ev) => setTo(ev.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
            </Field>
            <button
              onClick={load}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              {loading ? "Loading…" : "Apply Filters"}
            </button>
          </div>
        </div>

        {/* Bot details */}
        <div className="rounded-xl border border-slate-100 bg-white p-6 shadow-card">
          <h2 className="mb-5 flex items-center gap-2 text-base font-semibold text-slate-800">
            <span>🤖</span> Bot Details
            {isSummary && (
              <span className="ml-2 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-600">
                latest entry values
              </span>
            )}
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-1">
            <div>
              {BOT_DETAILS_LEFT.map((f) => (
                <DetailRow key={f.key} label={f.label} value={formatValue(e[f.key], f.format)} />
              ))}
            </div>
            <div>
              {BOT_DETAILS_RIGHT.map((f) => (
                <DetailRow key={f.key} label={f.label} value={formatValue(e[f.key], f.format)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <h1 className="text-lg font-bold text-slate-800">Trading Bot Analytics</h1>
      <div className="flex items-center gap-4 text-slate-500">
        <span>🔔</span>
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-brand text-sm font-semibold text-white">
            AD
          </span>
          <span className="text-sm font-medium text-slate-700">Admin</span>
        </div>
      </div>
    </header>
  );
}

function InfoCard({ label, big, small, icon, boldSmall = false }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
      <div className="flex items-center gap-2 mb-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-sm">{icon}</span>
        <span className="text-xs font-medium text-slate-500">{label}</span>
      </div>
      <div className="text-lg font-bold text-slate-800 truncate">{big}</div>
      {small && (
        <div className={boldSmall ? "text-lg font-bold text-slate-800 truncate" : "text-xs text-slate-400"}>
          {small}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-600">{label}</label>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-slate-100 py-2.5">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function formatDate(dt) {
  if (!dt) return "—";
  const d = new Date(String(dt).replace(" ", "T"));
  if (isNaN(d)) return String(dt);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(dt) {
  const d = new Date(String(dt).replace(" ", "T"));
  if (isNaN(d)) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

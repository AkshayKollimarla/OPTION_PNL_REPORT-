"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { formatValue, METRIC_CARDS } from "../../lib/fields";
import { toCsv, downloadCsv, csvName, num, perRtpPnl } from "../../lib/csv";

const PREVIEW_METRICS = ["rtp_pnl", "net_pnl", "volume", "apy"];
const previewFields = METRIC_CARDS.filter((f) => PREVIEW_METRICS.includes(f.key));

// What the download holds, in this order.
//
// The figures asked for, with the date, coin and account in front of them: a
// file of numbers with nothing saying which coin or day they belong to cannot
// be reconciled against anything.
//
// Per RTP PNL is not a stored column -- it is RTP PNL divided by the RTPs that
// earned it, which is the figure the entry log shows per row.
const CSV_COLUMNS = [
  { header: "Date",                value: (r) => formatDatetime(r.entry_datetime) },
  { header: "Token",               value: (r) => r.token_name },
  { header: "Symbol",              value: (r) => r.token_symbol },
  { header: "Account",             value: (r) => r.account },
  { header: "Exchange",            value: (r) => r.exchange },
  { header: "Investment",          value: (r) => num(r.investment) },
  { header: "RTPS",                value: (r) => num(r.rtps, 4) },
  { header: "Per RTP PNL",         value: (r) => num(perRtpPnl(r.rtp_pnl, r.rtps), 4) },
  { header: "RTP PNL",             value: (r) => num(r.rtp_pnl) },
  { header: "Per Hour RTP",        value: (r) => num(r.per_hour_rtps, 4) },
  { header: "Rebates",             value: (r) => num(r.rebates) },
  { header: "Flatten",             value: (r) => num(r.flatten_pnl) },
  { header: "Hedge Recovery PNL",  value: (r) => num(r.gamma_booked) },
  { header: "Net PNL",             value: (r) => num(r.net_pnl) },
  { header: "Volume",              value: (r) => num(r.volume) },
  { header: "APY",                 value: (r) => num(r.apy) },
];

function baseSymbol(name) { return name ? name.split("-")[0] : ""; }

function toLocalDate(dt) {
  if (!dt) return null;
  const s = String(dt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d)) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function EntriesLog() {
  const [entries,    setEntries]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmId,  setConfirmId]  = useState(null);

  // Filters
  const [filterExchange, setFilterExchange] = useState("all");
  const [filterSymbol,  setFilterSymbol]  = useState("all");
  const [filterAccount, setFilterAccount] = useState("all");
  const [filterFrom,    setFilterFrom]    = useState("");
  const [filterTo,      setFilterTo]      = useState("");

  const [allAccounts,   setAllAccounts]   = useState([]);
  const [allSymbols,    setAllSymbols]    = useState([]);
  const [symExchange,   setSymExchange]   = useState({});
  const [allExchanges,  setAllExchanges]  = useState([]);
  const [acctExchange,  setAcctExchange]  = useState({});
  const [truncated,     setTruncated]     = useState(false);

  // EVERY filter is applied server-side, over the whole table.
  //
  // Filtering client-side only ever narrowed the rows already fetched, and the
  // fetch returned just the newest page of them — so an older entry looked
  // deleted when it was merely past the page boundary. HIMS stopped appearing
  // the day the table passed 500 rows: its four June entries are the oldest in
  // the log, the page asked for the 500 newest, and picking HIMS then searched
  // a window that no longer contained it. Asking the database to do the
  // filtering makes every match reachable however far back it sits.
  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterFrom) qs.set("from", filterFrom);
    if (filterTo)   qs.set("to",   filterTo);
    if (filterExchange !== "all") qs.set("exchange", filterExchange);
    if (filterAccount  !== "all") qs.set("account",  filterAccount);
    // The dropdown offers base symbols (SOL), the column holds instruments
    // (SOL-USDC-PERPETUAL), so this is a prefix match.
    if (filterSymbol   !== "all") qs.set("symbol_base", filterSymbol);
    qs.set("limit", "1000");
    fetch(`/api/entries?${qs}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        const sorted = (json.entries || []).sort((a, b) => {
          const diff = new Date(String(b.entry_datetime).replace(" ", "T")) -
                       new Date(String(a.entry_datetime).replace(" ", "T"));
          return diff !== 0 ? diff : b.id - a.id;
        });
        setEntries(sorted);
        // Distinct across the WHOLE table, not just the rows on screen, so a
        // symbol never disappears from the dropdown just because the current
        // window happens to exclude it.
        setAllAccounts(json.accounts || []);
        setAllSymbols(json.symbols || []);
        setSymExchange(json.symbolExchange || {});
        setAllExchanges(json.exchanges || []);
        setAcctExchange(json.accountExchange || {});
        setTruncated(!!json.truncated);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterFrom, filterTo, filterExchange, filterAccount, filterSymbol]);

  // Unique symbols (ETH, SOL, BTC…)
  // Each dropdown is scoped by the one above it, so the choices on offer are
  // only ever combinations that actually exist.
  const accountsInExchange = useMemo(() => (
    filterExchange === "all"
      ? allAccounts
      : allAccounts.filter((a) => acctExchange[a] === filterExchange)
  ), [allAccounts, acctExchange, filterExchange]);

  const symbols = useMemo(() => {
    const inExchange = filterExchange === "all"
      ? allSymbols
      : allSymbols.filter((sym) => symExchange[sym] === filterExchange);
    return [...new Set(inExchange.map((sym) => baseSymbol(sym)).filter(Boolean))].sort();
  }, [allSymbols, symExchange, filterExchange]);

  // Unique accounts filtered by selected symbol
  const accounts = useMemo(() => {
    return [...new Set(accountsInExchange.filter(Boolean))].sort();
  }, [accountsInExchange]);

  // Reset account when symbol changes
  const handleSymbolChange = (v) => setFilterSymbol(v);
  const handleExchangeChange = (v) => { setFilterExchange(v); setFilterSymbol("all"); setFilterAccount("all"); };

  // Redundant now that the server filters, and kept only so the table cannot
  // briefly show the previous result set while the refetch is in flight.
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filterExchange !== "all" && (e.exchange || acctExchange[e.account]) !== filterExchange) return false;
      if (filterSymbol  !== "all" && baseSymbol(e.token_symbol) !== filterSymbol) return false;
      if (filterAccount !== "all" && e.account !== filterAccount) return false;
      return true; // dates are handled server-side by the fetch above

    });
  }, [entries, filterExchange, filterSymbol, filterAccount, filterFrom, filterTo, acctExchange]);

  const hasFilters = filterExchange !== "all" || filterSymbol !== "all" || filterAccount !== "all" || filterFrom || filterTo;

  async function handleDelete(id) {
    setDeletingId(id);
    setConfirmId(null);
    try {
      const res = await fetch(`/api/entries/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed");
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <header className="flex min-h-[4rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 sm:h-16 sm:flex-nowrap sm:py-0 border-b border-slate-200 bg-white px-4 sm:px-6">
        <h1 className="text-lg font-bold text-slate-800">Entries Log</h1>
        <Link href="/manual-entry"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
          + New Entry
        </Link>
      </header>

      <div className="p-4 sm:p-6 space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* Filters */}
        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Exchange</label>
              <select value={filterExchange} onChange={(e) => handleExchangeChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none">
                <option value="all">All Exchanges</option>
                {allExchanges.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Symbol</label>
              <select value={filterSymbol} onChange={(e) => handleSymbolChange(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none">
                <option value="all">All Symbols</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Account</label>
              <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none">
                <option value="all">All Accounts</option>
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Date From</label>
              <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Date To</label>
              <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none" />
            </div>
            <div className="flex items-end gap-2">
              {/* Exports what is on screen, filters and all -- a download that
                  quietly gave you the whole table would not match the figures
                  it sits beside. */}
              <button
                onClick={() => downloadCsv(
                  csvName("entry-log", filterFrom, filterTo),
                  toCsv(filtered, CSV_COLUMNS),
                )}
                disabled={!filtered.length}
                title={filtered.length
                  ? `Download these ${filtered.length} row${filtered.length === 1 ? "" : "s"} as CSV`
                  : "Nothing to download"}
                className="whitespace-nowrap rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 disabled:hover:bg-emerald-50">
                &darr; CSV
              </button>
              {hasFilters && (
                <button onClick={() => { setFilterExchange("all"); setFilterSymbol("all"); setFilterAccount("all"); setFilterFrom(""); setFilterTo(""); }}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
                  Clear Filters
                </button>
              )}
              <span className="text-xs text-slate-400 whitespace-nowrap self-center">
                {filtered.length} / {entries.length}
              </span>
            </div>
          </div>
        </div>

        {/* The row cap was silently swallowing the oldest entries: the state was
            already tracked and simply never rendered, so the log looked
            complete when it was not. Say so instead. */}
        {truncated && !loading && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Showing the 1,000 newest matching entries — older ones are not on
            this page. Narrow by exchange, symbol, account or date to reach them.
          </div>
        )}

        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {entries.length === 0
              ? <><span>No entries yet. </span><Link href="/manual-entry" className="font-semibold underline">Add the first one.</Link></>
              : "No entries match the selected filters."}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-left">#</th>
                  <th className="px-4 py-3 text-left">Date &amp; Time</th>
                  <th className="px-4 py-3 text-left">Token</th>
                  <th className="px-4 py-3 text-left">Investment</th>
                  {previewFields.map((f) => (
                    <th key={f.key} className="px-4 py-3 text-right">{f.label}</th>
                  ))}
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr key={row.id}
                    className={`border-b border-slate-50 hover:bg-slate-50 transition-colors ${i % 2 === 0 ? "bg-white" : "bg-slate-50/40"}`}>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{row.id}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">{formatDatetime(row.entry_datetime)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-md bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">{row.token_name}</span>
                      {row.token_symbol && (
                        <span className="ml-1.5 text-xs text-slate-400">{row.token_symbol}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{formatValue(row.investment, "currency")}</td>
                    {previewFields.map((f) => (
                      <td key={f.key} className="px-4 py-3 text-right font-semibold text-slate-800">
                        {formatValue(row[f.key], f.format)}
                      </td>
                    ))}
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-2">
                        <Link href={`/manual-entry?from=${row.id}`}
                          className="rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand hover:text-white transition-colors">
                          Edit / Copy
                        </Link>
                        {confirmId === row.id ? (
                          <>
                            <button onClick={() => handleDelete(row.id)} disabled={deletingId === row.id}
                              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition-colors">
                              {deletingId === row.id ? "Deleting…" : "Confirm"}
                            </button>
                            <button onClick={() => setConfirmId(null)}
                              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 transition-colors">
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button onClick={() => setConfirmId(row.id)}
                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-50 transition-colors">
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDatetime(dt) {
  if (!dt) return "—";
  const d = new Date(String(dt).replace(" ", "T"));
  if (isNaN(d)) return String(dt);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

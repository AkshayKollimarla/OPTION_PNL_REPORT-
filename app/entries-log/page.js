"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { formatValue, METRIC_CARDS } from "../../lib/fields";

const PREVIEW_METRICS = ["rtp_pnl", "net_pnl", "volume", "apy"];
const previewFields = METRIC_CARDS.filter((f) => PREVIEW_METRICS.includes(f.key));

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
  const [filterSymbol,  setFilterSymbol]  = useState("all");
  const [filterAccount, setFilterAccount] = useState("all");
  const [filterFrom,    setFilterFrom]    = useState("");
  const [filterTo,      setFilterTo]      = useState("");

  useEffect(() => {
    fetch("/api/entries")
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        const sorted = (json.entries || []).sort((a, b) => {
          const diff = new Date(String(b.entry_datetime).replace(" ", "T")) -
                       new Date(String(a.entry_datetime).replace(" ", "T"));
          return diff !== 0 ? diff : b.id - a.id;
        });
        setEntries(sorted);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Unique symbols (ETH, SOL, BTC…)
  const symbols = useMemo(() => {
    const s = new Set(entries.map((e) => baseSymbol(e.token_name)).filter(Boolean));
    return [...s].sort();
  }, [entries]);

  // Unique accounts filtered by selected symbol
  const accounts = useMemo(() => {
    const source = filterSymbol === "all"
      ? entries
      : entries.filter((e) => baseSymbol(e.token_name) === filterSymbol);
    const s = new Set(source.map((e) => e.token_name).filter(Boolean));
    return [...s].sort();
  }, [entries, filterSymbol]);

  // Reset account when symbol changes
  const handleSymbolChange = (v) => { setFilterSymbol(v); setFilterAccount("all"); };

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filterSymbol  !== "all" && baseSymbol(e.token_name) !== filterSymbol)  return false;
      if (filterAccount !== "all" && e.token_name !== filterAccount) return false;
      const d = toLocalDate(e.entry_datetime);
      if (filterFrom && d && d < filterFrom) return false;
      if (filterTo   && d && d > filterTo)   return false;
      return true;
    });
  }, [entries, filterSymbol, filterAccount, filterFrom, filterTo]);

  const hasFilters = filterSymbol !== "all" || filterAccount !== "all" || filterFrom || filterTo;

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
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <h1 className="text-lg font-bold text-slate-800">Entries Log</h1>
        <Link href="/manual-entry"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
          + New Entry
        </Link>
      </header>

      <div className="p-6 space-y-4">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {/* Filters */}
        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
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
              {hasFilters && (
                <button onClick={() => { setFilterSymbol("all"); setFilterAccount("all"); setFilterFrom(""); setFilterTo(""); }}
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

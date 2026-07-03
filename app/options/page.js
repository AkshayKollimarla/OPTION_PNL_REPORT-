"use client";

import { useEffect, useState, useMemo, Fragment, useCallback } from "react";
import Link from "next/link";

const PAGE_SIZE = 50;

const STATUS_COLORS = {
  open:   "bg-emerald-100 text-emerald-700",
  closed: "bg-slate-100 text-slate-600",
};

export default function OptionsDashboard() {
  const [trades,     setTrades]     = useState([]);
  const [filter,     setFilter]     = useState("all");
  const [search,     setSearch]     = useState("");
  const [dateFrom,   setDateFrom]   = useState("");
  const [dateTo,     setDateTo]     = useState("");
  const [page,       setPage]       = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [confirmId,  setConfirmId]  = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback((status, tokenQ, from, to, pg) => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status !== "all") qs.set("status", status);
    if (tokenQ)  qs.set("token",     tokenQ);
    if (from)    qs.set("date_from", from);
    if (to)      qs.set("date_to",   to);
    qs.set("page",  pg);
    qs.set("limit", PAGE_SIZE);

    fetch(`/api/options/trades?${qs}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setTrades(j.trades || []);
        setTotal(j.total   ?? 0);
        setTotalPages(j.pages ?? 1);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
    load(filter, search, dateFrom, dateTo, 1);
  }, [filter, search, dateFrom, dateTo, load]);

  // Load new page without resetting
  useEffect(() => {
    load(filter, search, dateFrom, dateTo, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function handleDelete(id) {
    setDeletingId(id); setConfirmId(null);
    try {
      const res = await fetch(`/api/options/trades/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      setTrades((prev) => prev.filter((t) => t.id !== id));
      setTotal((n) => n - 1);
    } catch (e) { setError(e.message); }
    finally { setDeletingId(null); }
  }

  // Memoised stats (from current page — full counts come from `total`)
  const open      = trades.filter((t) => t.status === "open").length;
  const closed    = trades.filter((t) => t.status === "closed").length;
  const bookedPnl = trades.filter((t) => t.status === "closed")
    .reduce((s, t) => s + Number(t.net_booked_pnl || 0), 0);

  // Memoised render units — only recomputes when trades array reference changes
  const renderUnits = useMemo(() => {
    const seen  = new Set();
    const units = [];
    trades.forEach((t) => {
      if (t.group_id) {
        if (!seen.has(t.group_id)) {
          seen.add(t.group_id);
          const members = trades.filter((x) => x.group_id === t.group_id);
          units.push({ type: "combined", group_id: t.group_id, members });
        }
      } else {
        units.push({ type: "single", trade: t });
      }
    });
    return units;
  }, [trades]);

  const COL_COUNT = 13;

  function clearFilters() {
    setSearch(""); setDateFrom(""); setDateTo(""); setFilter("all");
  }

  const hasFilters = search || dateFrom || dateTo || filter !== "all";

  return (
    <div>
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <h1 className="text-lg font-bold text-slate-800">Options Strategy</h1>
        <Link href="/options/add"
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors">
          + Add Strategy
        </Link>
      </header>

      <div className="p-6 space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total (this page)" value={`${trades.length} / ${total}`} color="blue" />
          <StatCard label="Open (page)"        value={open}                          color="green" />
          <StatCard label="Closed (page)"      value={closed}                        color="slate" />
          <StatCard label="Booked PnL (page)"  value={fmtCcy(bookedPnl)}            color={bookedPnl >= 0 ? "green" : "red"} />
        </div>

        {/* ── Filters row ── */}
        <div className="flex flex-wrap gap-3 items-end">
          {/* Status tabs */}
          <div className="flex gap-1.5">
            {["all","open","closed"].map((s) => (
              <button key={s} onClick={() => setFilter(s)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                  filter === s ? "bg-brand text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                {s}
              </button>
            ))}
          </div>

          {/* Token search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search token…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-200 pl-8 pr-3 py-1.5 text-sm focus:border-brand focus:outline-none w-40"
            />
            <svg className="absolute left-2.5 top-2 h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/>
            </svg>
          </div>

          {/* Date range */}
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-brand focus:outline-none" />
          <span className="text-xs text-slate-400 self-center">to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-brand focus:outline-none" />

          {hasFilters && (
            <button onClick={clearFilters}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">
              Clear filters
            </button>
          )}

          <span className="ml-auto text-xs text-slate-400 self-center">
            {total} record{total !== 1 ? "s" : ""} total
          </span>
        </div>

        {/* ── Table ── */}
        {loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : trades.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No strategies found.{!hasFilters && <> <Link href="/options/add" className="font-semibold underline">Add one.</Link></>}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-100 bg-white shadow-card overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  {["#","Date","Token","Type","Strike","Expiry","Days","Status","Investment","MM PL","Booked PnL","APY","Actions"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {renderUnits.map((unit) => {
                  if (unit.type === "combined") {
                    const combinedPnl = unit.members.reduce((s, m) => s + Number(m.net_booked_pnl || 0), 0);
                    const perLegInv   = Number(unit.members[0]?.investment || 0);
                    const combinedApy = perLegInv ? (combinedPnl / (perLegInv * unit.members.length)) * 365 * 100 : null;

                    return (
                      <Fragment key={unit.group_id}>
                        <tr className="bg-violet-50 border-b border-violet-100">
                          <td colSpan={COL_COUNT} className="px-4 py-2 border-l-4 border-violet-500">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-3 py-0.5 text-xs font-bold text-white">
                                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                                COMBINED STRATEGY
                              </span>
                              <span className="text-xs text-violet-600 font-medium">{unit.members.length} legs</span>
                              {perLegInv > 0 && <span className="text-xs text-slate-500">Per leg: <strong>{fmtCcy(perLegInv)}</strong></span>}
                              {combinedPnl !== 0 && (
                                <span className={`text-xs font-semibold ${combinedPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                  Combined PnL: {fmtCcy(combinedPnl)}
                                </span>
                              )}
                              {combinedApy != null && combinedApy !== 0 && (
                                <span className="text-xs font-semibold text-purple-600">APY: {combinedApy.toFixed(2)}%</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {unit.members.map((t) => (
                          <TradeRow key={t.id} t={t} combined groupId={unit.group_id}
                            confirmId={confirmId} deletingId={deletingId}
                            onConfirm={setConfirmId} onDelete={handleDelete} onCancel={() => setConfirmId(null)} />
                        ))}
                      </Fragment>
                    );
                  }
                  return (
                    <TradeRow key={unit.trade.id} t={unit.trade} combined={false}
                      confirmId={confirmId} deletingId={deletingId}
                      onConfirm={setConfirmId} onDelete={handleDelete} onCancel={() => setConfirmId(null)} />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination ── */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-slate-500">
              Page {page} of {totalPages} &nbsp;·&nbsp; {total} records
            </span>
            <div className="flex gap-1.5">
              <PageBtn onClick={() => setPage(1)}          disabled={page === 1}          label="«" />
              <PageBtn onClick={() => setPage((p) => p-1)} disabled={page === 1}          label="‹ Prev" />
              {pageWindow(page, totalPages).map((p) => (
                <button key={p} onClick={() => setPage(p)}
                  className={`min-w-[2rem] rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                    p === page ? "bg-brand text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                  {p}
                </button>
              ))}
              <PageBtn onClick={() => setPage((p) => p+1)} disabled={page === totalPages} label="Next ›" />
              <PageBtn onClick={() => setPage(totalPages)}  disabled={page === totalPages} label="»" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PageBtn({ onClick, disabled, label }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
      {label}
    </button>
  );
}

function pageWindow(current, total) {
  const delta = 2;
  const pages = [];
  for (let i = Math.max(1, current - delta); i <= Math.min(total, current + delta); i++) {
    pages.push(i);
  }
  return pages;
}

/* ── Trade Row ─────────────────────────────────────────── */

function TradeRow({ t, combined, groupId, confirmId, deletingId, onConfirm, onDelete, onCancel }) {
  const borderCls = combined
    ? "border-b border-violet-50 border-l-4 border-l-violet-300 bg-violet-50/30 hover:bg-violet-50 transition-colors"
    : "border-b border-slate-50 hover:bg-slate-50 transition-colors";

  return (
    <tr className={borderCls}>
      <td className="px-4 py-3 text-xs text-slate-400 font-mono">{t.id}</td>
      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{fmtDate(t.entry_date)}</td>
      <td className="px-4 py-3">
        <div className="font-semibold text-slate-800">{t.token}</div>
        {combined && <div className="text-xs text-violet-500 font-medium mt-0.5">leg</div>}
      </td>
      <td className="px-4 py-3">
        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${t.option_type === "PUT" ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>
          {t.option_type}
        </span>
      </td>
      <td className="px-4 py-3 text-slate-700">{t.options_strike || "—"}</td>
      <td className="px-4 py-3 whitespace-nowrap text-slate-700">{fmtDate(t.expiry)}</td>
      <td className="px-4 py-3 text-slate-700">{t.days_to_expiry ?? "—"}</td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_COLORS[t.status] || "bg-slate-100 text-slate-600"}`}>
          {t.status}
        </span>
      </td>
      <td className="px-4 py-3 text-slate-700">{fmtCcy(t.investment)}</td>
      <td className={`px-4 py-3 font-semibold ${Number(t.market_making_pl) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
        {fmtCcy(t.market_making_pl)}
      </td>
      <td className={`px-4 py-3 font-semibold ${Number(t.net_booked_pnl) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
        {t.net_booked_pnl != null ? fmtCcy(t.net_booked_pnl) : "—"}
      </td>
      <td className="px-4 py-3 font-semibold text-purple-600">{t.apy != null ? `${Number(t.apy).toFixed(2)}%` : "—"}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {combined && groupId ? (
            <Link href={`/options/simulator?edit_group=${groupId}`}
              className="rounded-lg border border-violet-500 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-600 hover:text-white transition-colors whitespace-nowrap">
              Edit Combined
            </Link>
          ) : (
            <Link href={`/options/edit/${t.id}`}
              className="rounded-lg border border-brand px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand hover:text-white transition-colors whitespace-nowrap">
              Edit / Close
            </Link>
          )}
          {confirmId === t.id ? (
            <>
              <button onClick={() => onDelete(t.id)} disabled={deletingId === t.id}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition-colors">
                {deletingId === t.id ? "…" : "Confirm"}
              </button>
              <button onClick={onCancel}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition-colors">
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => onConfirm(t.id)}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-50 transition-colors">
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ── Helpers ───────────────────────────────────────────── */

function StatCard({ label, value, color }) {
  const cls = { blue:"text-blue-600", green:"text-emerald-600", red:"text-red-600", slate:"text-slate-600" }[color] || "text-slate-700";
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-card">
      <p className="text-xs font-medium text-slate-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${cls}`}>{value}</p>
    </div>
  );
}

function fmtCcy(v) {
  const n = Number(v);
  if (isNaN(n) || v === null || v === undefined || v === "") return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(String(d).replace(" ", "T"));
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

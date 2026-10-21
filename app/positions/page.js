"use client";

import { useCallback, useEffect, useState } from "react";

const money = (v, places = 2) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: places });

const qty = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 });

export default function PositionsPage() {
  const [rows, setRows]         = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [venueErrors, setVErr]  = useState([]);
  const [account, setAccount]   = useState("all");
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [closing, setClosing]   = useState(null);
  const [result, setResult]     = useState(null);

  const load = useCallback((acct) => {
    fetch(`/api/positions?account=${encodeURIComponent(acct)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setRows(j.positions || []);
        setVErr(j.errors || []);
        if (acct === "all") setAccounts(j.accounts || []);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { setLoading(true); load(account); }, [account, load]);
  // Mark-to-market is the point of the page, so it keeps itself current.
  useEffect(() => {
    const t = setInterval(() => load(account), 15_000);
    return () => clearInterval(t);
  }, [account, load]);

  async function close(row) {
    const ok = window.confirm(
      `Close ${row.side} ${qty(row.size)} ${row.symbol} on ${row.account}?\n\n` +
      `This places a REAL resting order at the touch. It is reduce-only, so it can only close this position.`
    );
    if (!ok) return;
    setClosing(row.symbol); setResult(null); setError(null);
    try {
      const res = await fetch("/api/positions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: row.accountId, symbol: row.symbol }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setResult({ symbol: row.symbol, ...j });
      load(account);
    } catch (e) { setError(e.message); }
    finally { setClosing(null); }
  }

  const totalPnl = rows.reduce((s, r) => s + (Number(r.pnl) || 0), 0);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Positions</h1>
          <p className="text-xs text-slate-400">Live from the venue · refreshes every 15 seconds</p>
        </div>
        <div className="flex items-center gap-3">
          {rows.length > 0 && (
            <span className={`text-sm font-bold ${totalPnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
              {money(totalPnl)} unrealised
            </span>
          )}
          <select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 focus:border-brand focus:outline-none">
            <option value="all">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.venue}</option>)}
          </select>
        </div>
      </header>

      <div className="p-6 space-y-4">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {/* One venue failing must not read as "no positions". */}
        {venueErrors.map((v) => (
          <div key={v.account} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong>{v.account}</strong> could not be reached: {v.error}
          </div>
        ))}

        {result && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <strong>{result.symbol}</strong>: {result.side} {qty(result.qty)} resting at {money(result.limit, 4)}
            {result.orderId ? ` · order ${result.orderId}` : ""}
            <span className="ml-2 text-xs text-emerald-700">{result.note}</span>
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-slate-100 bg-white px-6 py-16 text-center text-sm text-slate-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-slate-100 bg-white px-6 py-16 text-center">
            <p className="text-sm font-semibold text-slate-600">No open positions</p>
            <p className="mt-1 text-sm text-slate-400">
              {account === "all" ? "Nothing is open on any account." : "Nothing is open on this account."}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  {["Account", "Symbol", "Side", "Size", "Avg Price", "Mark Price", "Unrealised PnL", "Value", ""].map((h, i) => (
                    <th key={h || i} className={`px-4 py-3 whitespace-nowrap ${i >= 3 && i <= 7 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.accountId}:${r.symbol}`} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-slate-700">{r.account}</span>
                      <span className="ml-1.5 text-[10px] uppercase text-slate-400">{r.venue}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
                      {r.symbol}
                      <span className="ml-1.5 font-sans text-[10px] uppercase text-slate-400">{r.assetClass}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        r.side === "long" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                        {r.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{qty(r.size)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{money(r.avgPrice, 4)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{money(r.markPrice, 4)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums font-bold ${
                      Number(r.pnl) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {money(r.pnl)}
                      {r.pnlPct !== null && r.pnlPct !== undefined && (
                        <span className="ml-1 text-[11px] font-medium text-slate-400">{money(r.pnlPct)}%</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{money(r.value)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => close(r)}
                        disabled={closing === r.symbol}
                        title="Place a resting, reduce-only order to close this position"
                        className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-100 disabled:opacity-50">
                        {closing === r.symbol ? "Closing…" : "Close"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-slate-400">
          Close places a <strong>resting</strong> limit order at the touch, reduce-only, so it adds liquidity rather than
          paying the spread and can only ever close. On Deribit it is post-only and will be rejected rather than cross.
          Alpaca has no post-only flag, so a fast market could still take the order there.
        </p>
      </div>
    </div>
  );
}

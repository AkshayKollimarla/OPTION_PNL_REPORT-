"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { computeDerived } from "../../../../lib/options-calculations";

const RISK_FREE = 0.05;
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function buildInst(t) {
  if (!t?.token || !t?.expiry || !t?.options_strike) return null;
  const d = new Date(t.expiry + "T00:00:00Z");
  if (isNaN(d)) return null;
  return `${t.token.toUpperCase()}-${String(d.getUTCDate()).padStart(2,"0")}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}-${t.options_strike}-${t.option_type === "CALL" ? "C" : "P"}`;
}

// BTC/ETH have both an inverse perpetual (BTC-PERPETUAL) and a USDC-margined
// linear perpetual (BTC_USDC-PERPETUAL) — use whichever the strategy was
// actually saved with, defaulting to inverse for strategies saved before
// this field existed.
function buildFuturesInst(token, futType) {
  const t = (token || "ETH").toUpperCase();
  const coin = t.replace(/_USDC$|_USDT$/, "");
  if (coin !== "BTC" && coin !== "ETH") return `${t}-PERPETUAL`;
  return futType === "linear" ? `${coin}_USDC-PERPETUAL` : `${coin}-PERPETUAL`;
}

function daysFromToday(expiryStr) {
  if (!expiryStr) return 0;
  const today  = new Date(); today.setHours(0,0,0,0);
  const expiry = new Date(expiryStr + "T00:00:00Z");
  return Math.max(0, Math.round((expiry - today) / 86400000));
}

function fmt(v, decimals = 2) {
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(decimals);
}

function Bar({ pct, color = "emerald" }) {
  const cls = { emerald:"bg-emerald-500", orange:"bg-orange-500", red:"bg-red-500", blue:"bg-blue-500" }[color] || "bg-emerald-500";
  const safe = Math.min(100, Math.max(0, pct));
  return (
    <div className="h-3 rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-700 ${cls}`} style={{ width: `${safe}%` }} />
    </div>
  );
}

const STATUS_COLOR = {
  active:           "bg-blue-100 text-blue-700",
  closing_option:   "bg-yellow-100 text-yellow-700",
  closing_futures:  "bg-orange-100 text-orange-700",
  closing:          "bg-yellow-100 text-yellow-700", // combo jobs use a single "closing" status, not the split option/futures phases
  completed:        "bg-emerald-100 text-emerald-700",
  failed:           "bg-red-100 text-red-700",
  stopped:          "bg-slate-100 text-slate-500",
};

export default function MonitorPage({ params }) {
  const tradeId = params.id;

  const [trade,      setTrade]      = useState(null);
  const [accounts,   setAccounts]   = useState([]);
  const [acct,       setAcct]       = useState("");
  const [balance,    setBalance]    = useState(null);
  const [ticker,     setTicker]     = useState(null);
  const [futTicker,  setFutTicker]  = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState(null);
  // Server-side auto-close job(s) for this trade (read-only view)
  const [svrJobs, setSvrJobs] = useState([]);
  // If this trade is one leg of a Combined Simulator group, its real
  // target/PnL/equity lives in a combo job (auto_close_combo_jobs), keyed
  // by group_id — not the single-leg table above at all.
  const [comboJob, setComboJob] = useState(null); // { job, legs }
  const autoRef  = useRef(null);
  const svrTimer = useRef(null);
  const comboTimer = useRef(null);

  // Load trade + accounts once
  useEffect(() => {
    Promise.all([
      fetch(`/api/options/trades/${tradeId}`).then(r => r.json()),
      fetch("/api/accounts").then(r => r.json()),
    ]).then(([td, ad]) => {
      if (td.error) { setError(td.error); return; }
      setTrade(td.trade);
      const accts = ad.accounts || [];
      setAccounts(accts);
      // Use the account this strategy was actually saved/executed with —
      // don't make the user reselect it every time they open a strategy's
      // Monitor page. Only fall back to "the one account" when the trade
      // itself has no account on record.
      if (td.trade?.account_id) setAcct(String(td.trade.account_id));
      else if (accts.length === 1) setAcct(String(accts[0].id));
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [tradeId]);

  // Load server jobs for this trade
  const loadSvrJobs = useCallback(async () => {
    try {
      const r = await fetch(`/api/auto-close?trade_id=${tradeId}`);
      const d = await r.json();
      if (d.jobs) setSvrJobs(d.jobs);
    } catch {}
  }, [tradeId]);

  useEffect(() => {
    loadSvrJobs();
    svrTimer.current = setInterval(loadSvrJobs, 10_000);
    return () => clearInterval(svrTimer.current);
  }, [loadSvrJobs]);

  // Load the combo job for this trade's group (if it belongs to one) —
  // picks the active/closing job if there is one, otherwise the most
  // recent one so a completed combo's final numbers still show.
  const loadComboJob = useCallback(async () => {
    if (!trade?.group_id) return;
    try {
      const r = await fetch(`/api/auto-close-combo?group_id=${encodeURIComponent(trade.group_id)}`);
      const d = await r.json();
      const jobs = d.jobs || [];
      if (!jobs.length) return;
      const target = jobs.find(j => ["active", "closing"].includes(j.status)) || jobs[0];
      const detailRes = await fetch(`/api/auto-close-combo?id=${target.id}`);
      const detail = await detailRes.json();
      if (detail.job) setComboJob(detail);
    } catch {}
  }, [trade?.group_id]);

  useEffect(() => {
    if (!trade?.group_id) return;
    loadComboJob();
    comboTimer.current = setInterval(loadComboJob, 10_000);
    return () => clearInterval(comboTimer.current);
  }, [trade?.group_id, loadComboJob]);

  const refresh = useCallback(async (accountId) => {
    const aid = accountId || acct;
    if (!aid || !trade) return;
    setRefreshing(true);
    try {
      const inst  = buildInst(trade);
      const token = (trade.token || "ETH").toUpperCase();
      const [balData, tickData, futData] = await Promise.all([
        fetch(`/api/balance?account_id=${aid}&mode=collateral&token=${token}`).then(r => r.json()),
        inst ? fetch(`/api/market?account_id=${aid}&token=${token}&action=ticker&instrument=${encodeURIComponent(inst)}`).then(r => r.json()) : Promise.resolve(null),
        fetch(`/api/market?account_id=${aid}&token=${token}&action=futures&instrument=${encodeURIComponent(buildFuturesInst(trade.token, trade.fut_instrument_type))}`).then(r => r.json()),
      ]);
      if (!balData.error) setBalance(balData);
      if (tickData && !tickData.error) setTicker(tickData);
      if (futData && !futData.error) setFutTicker(futData);
    } catch (e) { setError(e.message); }
    finally { setRefreshing(false); }
  }, [acct, trade]);

  // Auto-refresh every 30s when account is selected
  useEffect(() => {
    clearInterval(autoRef.current);
    if (acct && trade) {
      refresh(acct);
      autoRef.current = setInterval(() => refresh(acct), 30000);
    }
    return () => clearInterval(autoRef.current);
  }, [acct, trade, refresh]);

  async function stopSvrJob(id) {
    if (!confirm(`Stop auto-close job #${id}?`)) return;
    const r = await fetch(`/api/auto-close?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok) { alert(d.error); return; }
    loadSvrJobs();
  }

  async function stopComboJob(id) {
    if (!confirm(`Stop combo auto-close job #${id}? This stops ALL legs in the group.`)) return;
    const r = await fetch(`/api/auto-close-combo?id=${id}`, { method: "DELETE" });
    const d = await r.json();
    if (!r.ok) { alert(d.error); return; }
    loadComboJob();
  }

  if (loading) return <div className="p-8 text-sm text-slate-400">Loading…</div>;
  if (error)   return <div className="p-8 text-sm text-red-600">Error: {error}</div>;
  if (!trade)  return <div className="p-8 text-sm text-slate-400">Strategy not found.</div>;

  // ── Derived ──────────────────────────────────────────────
  // Prefer the live auto-close job's target/initial collateral — the trade
  // record's fields are a static snapshot from when the strategy was last
  // saved and go stale the moment the target is edited on a running job.
  // A trade that's one leg of a Combined Simulator group has its real
  // target/equity in a combo job instead (keyed by group_id, not trade_id) —
  // fall back to that when there's no single-leg job for this trade.
  const activeJob     = svrJobs.find(j => ["active","closing_option","closing_futures"].includes(j.status));
  const derived      = computeDerived(trade);
  const target_pnl   = activeJob ? (parseFloat(activeJob.target_pnl) || 0)
                      : comboJob ? (parseFloat(comboJob.job.target_pnl) || 0)
                      : (parseFloat(trade.target_pnl) || 0);
  const init_usd     = activeJob ? (parseFloat(activeJob.initial_total_usd) || 0)
                      : comboJob ? (parseFloat(comboJob.job.initial_total_usd) || 0)
                      : (parseFloat(trade.initial_collateral_usd) || 0);
  const optQty       = parseFloat(trade.opt_entry_qty)          || 0;
  const optEntry     = parseFloat(trade.opt_entry_price)        || 0;  // USD
  const futQty       = parseFloat(trade.fut_qty)                || 0;
  const futEntry     = parseFloat(trade.fut_entry_price)        || 0;
  const strike       = parseFloat(trade.options_strike)         || 0;
  const optType      = (trade.option_type || "PUT").toUpperCase();
  const daysLeft     = daysFromToday(trade.expiry);
  const T_years      = Math.max(0.0001, daysLeft / 365);

  // Live equity PnL
  const live_usd    = balance?.total_usd ?? 0;
  const equity_pnl  = init_usd > 0 ? live_usd - init_usd : null;
  const eq_progress = target_pnl > 0 && equity_pnl != null ? (equity_pnl / target_pnl) * 100 : 0;

  // Live BS option PnL
  const S          = ticker?.underlying_price || futEntry;
  const liveIV     = (ticker?.mark_iv || parseFloat(trade.iv) || 30) / 100;
  const liveOptUsd = ticker?.mark_price_usd ?? 0;
  const bsOptPnl   = liveOptUsd > 0 ? (liveOptUsd - optEntry) * optQty : null;
  // Use the perpetual's own mark price, not the option's underlying index
  // price — they diverge (basis), which was showing the wrong futures PnL.
  const futCurrent = futTicker?.mark_price || ticker?.underlying_price || futEntry;
  const futPnl     = futQty * (futCurrent - futEntry);
  const netBsPnl   = bsOptPnl != null ? bsOptPnl + futPnl : null;

  // Expiry scenario PnL (from computeDerived)
  const upTarget   = derived.estimated_upside_net_pnl   ?? 0;
  const downTarget = derived.estimated_downside_net_pnl ?? 0;

  // Execution logs
  let logs = [];
  try { if (trade.execution_log) logs = JSON.parse(trade.execution_log); } catch {}

  const inst = buildInst(trade);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center gap-3 h-14 border-b border-slate-200 bg-white px-5">
        <Link href="/options" className="text-xs text-slate-500 hover:text-brand transition-colors">← Strategies</Link>
        <span className="text-slate-300">|</span>
        <h1 className="text-sm font-bold text-slate-800">Monitor #{tradeId}</h1>
        <span className="rounded-full px-2 py-0.5 text-xs font-semibold capitalize bg-emerald-100 text-emerald-700 ml-1">
          {trade.status}
        </span>
        <span className="ml-auto text-xs text-slate-500">
          {trade.token} · {optType} · Strike {strike} · {trade.expiry} · {daysLeft}d left
        </span>
      </header>

      <div className="p-5 space-y-4 max-w-4xl mx-auto">

        {/* Account + Refresh */}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Deribit Account</label>
            <select
              value={acct}
              onChange={e => setAcct(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            >
              <option value="">— select account —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>
          <button
            onClick={() => refresh()}
            disabled={!acct || refreshing}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {refreshing ? "Refreshing…" : "🔄 Refresh Live"}
          </button>
          {activeJob && (
            <button
              onClick={() => stopSvrJob(activeJob.id)}
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-100 transition-colors"
            >
              ■ Stop Monitor
            </button>
          )}
          {balance && <p className="text-xs text-slate-400 self-center">Auto-refreshes every 30s</p>}
        </div>

        {/* ── Profit Target Progress ── */}
        {(target_pnl > 0 || init_usd > 0) && (
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-800">Profit Target Monitor</h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                <p className="text-xs text-slate-400 mb-0.5">Initial Collateral</p>
                <p className="text-sm font-bold text-slate-700">{init_usd > 0 ? `$${init_usd.toFixed(2)}` : "—"}</p>
              </div>
              <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
                <p className="text-xs text-slate-400 mb-0.5">Profit Target</p>
                <p className="text-sm font-bold text-emerald-700">+{target_pnl > 0 ? `$${target_pnl.toFixed(2)}` : "—"}</p>
              </div>
              <div className={`rounded-lg border p-3 ${balance ? "bg-blue-50 border-blue-100" : "bg-slate-50 border-slate-100"}`}>
                <p className="text-xs text-slate-400 mb-0.5">{balance?.coin_symbol && balance.coin_symbol !== "USDC" ? `${balance.coin_symbol} Equity ($)` : "Coin Equity ($)"}</p>
                <p className="text-sm font-bold text-blue-700">{balance ? `$${balance.coin_equity_usd?.toFixed(2) ?? "—"}` : "—"}</p>
              </div>
              <div className={`rounded-lg border p-3 ${balance ? "bg-blue-50 border-blue-100" : "bg-slate-50 border-slate-100"}`}>
                <p className="text-xs text-slate-400 mb-0.5">USDC Equity</p>
                <p className="text-sm font-bold text-blue-700">{balance ? `$${balance.usdc_equity?.toFixed(2) ?? "—"}` : "—"}</p>
              </div>
            </div>

            {balance && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">
                    Current Total: <strong className="text-blue-700">${live_usd.toFixed(2)}</strong>
                  </span>
                  <span className={`font-bold text-base ${equity_pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    Live PnL: {equity_pnl != null ? `${equity_pnl >= 0 ? "+" : ""}$${equity_pnl.toFixed(2)}` : "—"}
                    {target_pnl > 0 && equity_pnl != null && (
                      <span className="ml-2 text-xs font-normal text-slate-400">/ +${target_pnl.toFixed(2)} target</span>
                    )}
                  </span>
                </div>
                {target_pnl > 0 && equity_pnl != null && (
                  <>
                    <Bar pct={eq_progress} color={eq_progress >= 100 ? "emerald" : eq_progress > 50 ? "blue" : "orange"} />
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>$0</span>
                      <span className="font-semibold text-slate-600">{Math.max(0, eq_progress).toFixed(1)}% of target</span>
                      <span>+${target_pnl.toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {!balance && acct && (
              <p className="text-xs text-slate-400 italic">Click Refresh Live to load current equity.</p>
            )}
            {!acct && (
              <p className="text-xs text-slate-400 italic">Select an account above to see live equity progress.</p>
            )}
          </div>
        )}

        {/* ── Live BS PnL ── */}
        {ticker && (
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
            <h2 className="text-sm font-bold text-slate-800">Live Mark-to-Market PnL</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                <p className="text-xs text-slate-400 mb-0.5">Live Option Price</p>
                <p className="font-bold text-slate-800">${liveOptUsd.toFixed(4)}</p>
                <p className="text-xs text-slate-400">Entry: ${optEntry.toFixed(4)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                <p className="text-xs text-slate-400 mb-0.5">Live IV</p>
                <p className="font-bold text-slate-800">{ticker.mark_iv?.toFixed(1) ?? "—"}%</p>
                <p className="text-xs text-slate-400">Days left: {daysLeft}</p>
              </div>
              <div className={`rounded-lg border p-3 ${bsOptPnl != null ? (bsOptPnl >= 0 ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100") : "bg-slate-50 border-slate-100"}`}>
                <p className="text-xs text-slate-400 mb-0.5">Option PnL</p>
                <p className={`font-bold ${bsOptPnl != null ? (bsOptPnl >= 0 ? "text-emerald-700" : "text-red-600") : "text-slate-500"}`}>
                  {bsOptPnl != null ? fmt(bsOptPnl) : "—"}
                </p>
                <p className="text-xs text-slate-400">{optQty > 0 ? "Long" : "Short"} {Math.abs(optQty)}x</p>
              </div>
              <div className={`rounded-lg border p-3 ${netBsPnl != null ? (netBsPnl >= 0 ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100") : "bg-slate-50 border-slate-100"}`}>
                <p className="text-xs text-slate-400 mb-0.5">Net PnL (Opt + Fut)</p>
                <p className={`font-bold text-base ${netBsPnl != null ? (netBsPnl >= 0 ? "text-emerald-700" : "text-red-600") : "text-slate-500"}`}>
                  {netBsPnl != null ? fmt(netBsPnl) : "—"}
                </p>
                <p className="text-xs text-slate-400">
                  Fut: {fmt(futPnl)}{futTicker?.mark_price ? ` (mark $${Number(futTicker.mark_price).toFixed(2)} vs entry $${futEntry.toFixed(2)})` : ""}
                </p>
              </div>
            </div>

            {/* Progress toward estimated scenario targets */}
            {netBsPnl != null && (downTarget !== 0 || upTarget !== 0) && (
              <div className="space-y-2 pt-1">
                {downTarget !== 0 && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Downside scenario target: <strong>{fmt(downTarget)}</strong></span>
                      <span>{Math.max(0, (netBsPnl / downTarget) * 100).toFixed(1)}% there</span>
                    </div>
                    <Bar pct={(netBsPnl / downTarget) * 100} color="orange" />
                  </div>
                )}
                {upTarget !== 0 && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Upside scenario target: <strong>{fmt(upTarget)}</strong></span>
                      <span>{Math.max(0, (netBsPnl / upTarget) * 100).toFixed(1)}% there</span>
                    </div>
                    <Bar pct={(netBsPnl / upTarget) * 100} color="blue" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Strategy Details ── */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-slate-800 mb-3">Strategy Details</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-8 gap-y-2 text-xs">
            {[
              ["Option",         inst || "—"],
              ["Option Qty",     optQty],
              ["Option Entry $", optEntry.toFixed(4)],
              ["Futures",        buildFuturesInst(trade.token, trade.fut_instrument_type)],
              ["Futures Qty",    futQty],
              ["Futures Entry",  `$${futEntry.toFixed(2)}`],
              ["Investment",     trade.investment ? `$${parseFloat(trade.investment).toFixed(2)}` : "—"],
              ["Days Left",      daysLeft],
              ["Entry Date",     trade.entry_date || "—"],
            ].map(([label, val]) => (
              <div key={label} className="flex justify-between border-b border-slate-50 py-1">
                <span className="text-slate-400">{label}</span>
                <span className="font-medium text-slate-700">{val}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Execution Logs ── */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-bold text-slate-800 mb-3">
            Execution Log
            <span className="ml-2 text-xs font-normal text-slate-400">{logs.length} entries</span>
          </h2>
          {logs.length > 0 ? (
            <div className="rounded-lg bg-slate-900 p-3 max-h-72 overflow-y-auto font-mono text-xs text-slate-300 space-y-0.5">
              {logs.map((l, i) => (
                <div key={i} className={
                  l.includes("failed") || l.includes("Error") || l.includes("error") ? "text-red-400"
                  : l.includes("TARGET") || l.includes("complete") || l.includes("filled") || l.includes("Frozen") ? "text-emerald-400"
                  : l.includes("Placing") || l.includes("Waiting") ? "text-yellow-300"
                  : ""
                }>{l}</div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">
              No logs saved. Logs are captured when you execute a strategy and then save it from the Add Strategy page.
            </p>
          )}
        </div>

        {/* ── Combined Strategy Monitor ── */}
        {trade.group_id && (
          <div className="rounded-xl border border-violet-200 bg-white p-5 shadow-sm space-y-4">
            <div>
              <h2 className="text-sm font-bold text-slate-800">
                Combined Strategy Monitor
                <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                  {trade.group_id}
                </span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                This strategy is one leg of a combined group — its real target/PnL lives on the combo job below, not on this single leg.
                Start or stop it from the{" "}
                <Link href={`/options/simulator?edit_group=${encodeURIComponent(trade.group_id)}`} className="text-brand underline">
                  Edit Combined Strategy
                </Link> page.
              </p>
            </div>

            {comboJob?.job ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-slate-700">Job #{comboJob.job.id}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[comboJob.job.status] || "bg-slate-100 text-slate-500"}`}>
                    {comboJob.job.status.replace(/_/g, " ")}
                  </span>
                </div>

                {comboJob.job.last_equity_usd != null && (() => {
                  const pnl = parseFloat(comboJob.job.last_equity_usd) - parseFloat(comboJob.job.initial_total_usd);
                  const tgt = parseFloat(comboJob.job.target_pnl);
                  const pct = tgt > 0 ? Math.min(100, Math.max(0, (pnl / tgt) * 100)) : 0;
                  return (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-slate-500">
                        <span>Initial: ${parseFloat(comboJob.job.initial_total_usd).toFixed(2)}</span>
                        <span className={`font-bold ${pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          Live PnL: {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} / +${tgt.toFixed(2)} target
                        </span>
                      </div>
                      <Bar pct={pct} color={pct >= 100 ? "emerald" : pct > 50 ? "blue" : "orange"} />
                    </div>
                  );
                })()}

                {comboJob.legs?.length > 0 && (
                  <div className="space-y-1 text-xs text-slate-600">
                    {comboJob.legs.map(leg => (
                      <div key={leg.id} className="flex items-center gap-2 flex-wrap border-b border-slate-50 py-1">
                        <span className="font-medium">Leg {leg.leg_index + 1} ({leg.leg_type || "?"}):</span>
                        <span>{leg.opt_instrument}</span>
                        <span className={leg.opt_done ? "text-emerald-600" : "text-slate-400"}>{leg.opt_done ? "✓ opt closed" : "opt open"}</span>
                        {leg.fut_instrument && (
                          <span className={leg.fut_done ? "text-emerald-600" : "text-slate-400"}>{leg.fut_done ? "✓ fut closed" : "fut open"}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {["active", "closing"].includes(comboJob.job.status) && (
                  <button onClick={() => stopComboJob(comboJob.job.id)}
                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors">
                    ■ Stop Combo Auto-Close
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-400 italic">No combo auto-close job yet for this group.</p>
            )}
          </div>
        )}

        {/* ── Auto-Close Job Status ── */}
        <div className="rounded-xl border border-blue-200 bg-white p-5 shadow-sm space-y-4">
          <div>
            <h2 className="text-sm font-bold text-slate-800">Auto-Close Job Status</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Runs in the background on the server. Start or stop it from the{" "}
              <Link href={`/options/edit/${tradeId}`} className="text-brand underline">Edit Strategy</Link> page — this is a read-only view.
            </p>
          </div>

          {svrJobs.length > 0 ? (
            <div className="space-y-3">
              {svrJobs.map(j => (
                <ServerJobCard key={j.id} job={j} onStop={stopSvrJob} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">No auto-close jobs yet for this strategy.</p>
          )}
        </div>

      </div>
    </div>
  );
}

function ServerJobCard({ job, onStop }) {
  const [logs, setLogs] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    fetch(`/api/auto-close?id=${job.id}`)
      .then(r => r.json())
      .then(d => { if (d.job?.logs) setLogs(d.job.logs); })
      .catch(() => {});
  }, [expanded, job.id]);

  const isActive = ["active","closing_option","closing_futures"].includes(job.status);
  const pnl = job.last_equity_usd && job.initial_total_usd
    ? parseFloat(job.last_equity_usd) - parseFloat(job.initial_total_usd) : null;
  const pct = pnl != null && parseFloat(job.target_pnl) > 0
    ? (pnl / parseFloat(job.target_pnl)) * 100 : 0;

  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-slate-700">Job #{job.id}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[job.status] || "bg-slate-100 text-slate-500"}`}>
          {job.status.replace(/_/g," ")}
        </span>
        <span className="text-slate-400">{job.opt_instrument}</span>
        {job.fut_instrument && <span className="text-slate-400">+ {job.fut_instrument}</span>}
        <span className="ml-auto text-slate-400">created {job.created_at?.slice(0,16)}</span>
      </div>

      {/* Progress */}
      <div className="flex gap-4">
        <span className="text-slate-500">Initial: <strong>${parseFloat(job.initial_total_usd).toFixed(2)}</strong></span>
        <span className="text-slate-500">Target +<strong>${parseFloat(job.target_pnl).toFixed(2)}</strong></span>
        {job.last_equity_usd && (
          <span className={`font-semibold ${pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            Live PnL: {pnl >= 0 ? "+" : ""}${pnl?.toFixed(2) ?? "—"}
          </span>
        )}
        {job.last_checked_at && <span className="text-slate-400">checked {job.last_checked_at?.slice(11,16)}</span>}
      </div>

      {job.last_equity_usd && parseFloat(job.target_pnl) > 0 && (
        <Bar pct={pct} color={pct >= 100 ? "emerald" : pct > 50 ? "blue" : "orange"} />
      )}

      {job.error_msg && (
        <p className="text-red-600 font-mono">{job.error_msg}</p>
      )}

      <div className="flex gap-2">
        <button onClick={() => setExpanded(x => !x)}
          className="text-brand underline hover:no-underline">
          {expanded ? "Hide" : "Show"} logs
        </button>
        {isActive && (
          <button onClick={() => onStop(job.id)}
            className="text-red-600 underline hover:no-underline">Stop</button>
        )}
      </div>

      {expanded && (
        <div className="rounded-lg bg-slate-900 p-3 max-h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-0.5">
          {logs.length === 0 && <div className="text-slate-500">No log entries yet…</div>}
          {logs.map((l, i) => (
            <div key={i} className={
              l.includes("TARGET") || l.includes("filled") || l.includes("complete") ? "text-emerald-400"
              : l.includes("error") || l.includes("Error") || l.includes("Fatal") ? "text-red-400"
              : l.includes("limit") || l.includes("market") || l.includes("placed") ? "text-yellow-300"
              : ""
            }>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

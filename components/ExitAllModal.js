"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// SOL_USDC-7AUG26-70-P → { expiry: "7AUG26", strike: 70, type: "P" }
// Parsed from the right, because the token itself may contain a dash
// (SOL_USDC is safe, but BTC-6THJULY-style labels are not).
function parseOptInst(name) {
  const parts = String(name || "").split("-");
  if (parts.length < 4) return null;
  const type = parts[parts.length - 1];
  const strike = parseFloat(parts[parts.length - 2]);
  const expiry = parts[parts.length - 3];
  if ((type !== "C" && type !== "P") || !Number.isFinite(strike)) return null;
  return { expiry, strike, type };
}

const fmtNum = (v, dp = 4) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp });

// Matches Deribit's own instrument-naming convention — no zero-padded day
// (BTC-1AUG26-..., not BTC-01AUG26-...) — so an option position can be
// matched back to the saved strategy row it belongs to.
function buildOptInst(t) {
  if (!t?.token || !t?.expiry || !t?.options_strike) return null;
  const d = new Date(t.expiry + "T00:00:00Z");
  if (isNaN(d)) return null;
  return `${t.token.toUpperCase()}-${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}-${t.options_strike}-${t.option_type === "CALL" ? "C" : "P"}`;
}

function fmtUsd(v) {
  return v != null ? `$${Number(v).toFixed(2)}` : "—";
}

// Live net price of each vertical spread among the open positions, and where
// the user says they want to exit it.
//
// A spread is worth one number, not two: its net is what actually decides
// whether closing is worth doing, and reading it off two separately-moving
// leg prices is exactly the arithmetic that goes wrong under pressure. The
// quote poll is public data only, so it can refresh every couple of seconds
// without touching the authenticated position endpoint.
function SpreadExitPanel({ positions, targets, onTargetChange }) {
  const [quotes, setQuotes] = useState({});
  const [quotedAt, setQuotedAt] = useState(null);
  const timerRef = useRef(null);

  // Pair the option legs: same type and expiry, two legs, opposite sides.
  // Anything else is not a vertical spread and gets no net price rather than
  // a misleading one.
  const spreads = useMemo(() => {
    const opts = (positions || [])
      .filter(p => p.kind === "option")
      .map(p => ({ p, meta: parseOptInst(p.instrument_name) }))
      .filter(x => x.meta);
    const groups = {};
    opts.forEach(o => {
      const k = `${o.meta.type}|${o.meta.expiry}`;
      (groups[k] = groups[k] || []).push(o);
    });
    return Object.entries(groups)
      .filter(([, l]) => l.length === 2
        && l[0].p.direction !== l[1].p.direction
        && l[0].meta.strike !== l[1].meta.strike)
      .map(([key, l]) => {
        // "Expensive" is the nearer-the-money strike: lower strike for calls,
        // higher for puts. Derived from the strikes rather than from live
        // prices so the pairing stays stable as the market moves.
        const isCall = l[0].meta.type === "C";
        const sorted = [...l].sort((a, b) =>
          isCall ? a.meta.strike - b.meta.strike : b.meta.strike - a.meta.strike);
        const [expensive, cheap] = sorted;
        return {
          key,
          kind: isCall ? "CALL" : "PUT",
          expiry: expensive.meta.expiry,
          width: Math.abs(expensive.meta.strike - cheap.meta.strike),
          expensive, cheap,
          // Long the spread = long the expensive leg. Closing it means SELLING
          // the spread, so the achievable net is bid(exp) − ask(cheap).
          isLong: expensive.p.direction === "buy",
        };
      });
  }, [positions]);

  const instruments = useMemo(
    () => spreads.flatMap(s => [s.expensive.p.instrument_name, s.cheap.p.instrument_name]),
    [spreads]
  );

  useEffect(() => {
    if (!instruments.length) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await fetch(`/api/deribit-quotes?instruments=${encodeURIComponent(instruments.join(","))}`);
        const d = await r.json();
        if (cancelled || !d.quotes) return;
        setQuotes(d.quotes);
        setQuotedAt(new Date().toLocaleTimeString());
      } catch { /* transient — the next poll retries */ }
    };
    pull();
    timerRef.current = setInterval(pull, 3000);
    return () => { cancelled = true; clearInterval(timerRef.current); };
  }, [instruments.join(",")]);

  if (!spreads.length) return null;

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          Spread exit {spreads.length > 1 ? `(${spreads.length})` : ""}
        </span>
        <span className="text-[11px] text-indigo-400">
          live · {quotedAt ? `updated ${quotedAt}` : "connecting…"}
        </span>
      </div>

      {spreads.map((sp) => {
        const qe = quotes[sp.expensive.p.instrument_name];
        const qc = quotes[sp.cheap.p.instrument_name];
        const markNet = qe && qc && qe.mark != null && qc.mark != null ? qe.mark - qc.mark : null;
        // What the book would actually give right now, closing in the
        // direction this position requires.
        const liveNet = qe && qc
          ? (sp.isLong
              ? (qe.bid != null && qc.ask != null ? qe.bid - qc.ask : null)   // selling to close
              : (qe.ask != null && qc.bid != null ? qe.ask - qc.bid : null))  // buying to close
          : null;
        const pct = (v) => (v != null && sp.width > 0 ? ((v / sp.width) * 100).toFixed(1) + "%" : "—");
        const target = targets?.[sp.key] ?? "";

        return (
          <div key={sp.key} className="rounded border border-indigo-100 bg-white px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-semibold text-slate-800">
                {sp.kind} {fmtNum(sp.cheap.meta.strike, 2)}/{fmtNum(sp.expensive.meta.strike, 2)}
              </span>
              <span className="text-slate-400">{sp.expiry} · width {fmtNum(sp.width, 2)}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${sp.isLong ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {sp.isLong ? "LONG — sell to close" : "SHORT — buy to close"}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-slate-500">
                net @ mark <span className="font-semibold text-slate-700">{fmtNum(markNet)}</span>
                <span className="text-slate-400"> ({pct(markNet)})</span>
              </span>
              <span className="text-slate-500">
                achievable now <span className="font-semibold text-slate-700">{fmtNum(liveNet)}</span>
                <span className="text-slate-400"> ({pct(liveNet)})</span>
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium text-slate-600">Exit at net</label>
              <input
                type="number" step="any" placeholder={markNet != null ? fmtNum(markNet, 2) : "net price"}
                value={target}
                onChange={(e) => onTargetChange?.(sp.key, e.target.value)}
                className="w-28 rounded border border-slate-200 px-2 py-1 text-xs focus:border-brand focus:outline-none"
              />
              {target !== "" && sp.width > 0 && Number.isFinite(Number(target)) && (
                <span className="text-[11px] text-slate-500">
                  = {((Number(target) / sp.width) * 100).toFixed(1)}% of width
                  {liveNet != null && (
                    <span className={sp.isLong
                      ? (liveNet >= Number(target) ? " · reachable now" : " · better than market")
                      : (liveNet <= Number(target) ? " · reachable now" : " · better than market")}>
                      {sp.isLong
                        ? (liveNet >= Number(target) ? " ✓" : "")
                        : (liveNet <= Number(target) ? " ✓" : "")}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Shows every LIVE option/futures position Deribit currently has open for
// this account+token, fetched fresh right when the button is clicked (never
// the app's own saved/stale numbers) — the user reviews exactly what's about
// to be closed before the final confirm fires real reduce-only orders.
// Shared by the Add/Edit Strategy page and the Options Exit list page so the
// close behavior (and its confirmation UX) never drifts between the two.
//
// `trades` (the group's own saved options_trades rows, optional) lets each
// position show its historical entry price/collateral alongside the live
// exchange numbers — entry side is whatever was stored at entry time, exit
// side (mark/P&L before confirm, close price/collateral after) is always
// fetched fresh from the exchange, never estimated.
export default function ExitAllModal({
  token, loading, error, positions, trades = [], confirming, job, badIp,
  collateralBefore, fetchedAt, onConfirm, onRefresh, onClose,
  crossAfter, crossAfterUnit, onCrossAfterChange, onCrossAfterUnitChange,
  spreadTargets, onSpreadTargetChange,
}) {
  // `job` is the server-side close job that Confirm hands the work to. It's
  // not a completion receipt — closing is asynchronous from here on (options
  // are chased with maker re-quotes until they fill), so the panel below
  // deliberately says "started", never "closed".
  const started = !!job;

  const entryFor = (p) => {
    if (p.kind === "option") {
      const t = trades.find(tr => buildOptInst(tr) === p.instrument_name);
      return { price: t?.opt_entry_price ?? null, collateral: t?.initial_collateral_usd ?? null };
    }
    const t = trades.find(tr => tr.fut_entry_price != null);
    return { price: t?.fut_entry_price ?? null, collateral: t?.initial_collateral_usd ?? null };
  };
  const entryCollateral = trades.find(t => t.initial_collateral_usd != null)?.initial_collateral_usd ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-bold text-slate-800">
            Exit All {(token || "").toUpperCase()} Positions
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <div className="max-h-[65vh] overflow-y-auto px-5 py-4 space-y-3">
          {loading && <p className="text-sm text-slate-500">Fetching live positions from Deribit…</p>}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {!loading && !error && !started && positions.length === 0 && (
            <p className="text-sm text-slate-500">No open positions found for this coin on this account.</p>
          )}

          {started && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 space-y-2">
              <p className="font-semibold">✓ Close job #{job.combo_job_id} started</p>
              <p className="text-xs">{job.message}</p>
              <p className="text-xs">
                All option legs are worked at the same time as maker orders chased at mark, and any
                leftover futures are swept only after they finish. It keeps running even if you close
                this tab.
              </p>
              <a href="/options/monitor" className="inline-block text-xs font-semibold underline">
                Track progress in Monitor →
              </a>
            </div>
          )}

          {!loading && badIp && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Deribit rejected part of this request as <strong>bad_ip</strong> — this account's IP allowlist no
              longer matches this machine's current public IP. The list below may be incomplete until that's fixed
              in the account's Deribit security settings.
            </div>
          )}

          {!loading && positions.length > 0 && (
            <>
              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <span>
                  Entry collateral: <span className="font-semibold">{fmtUsd(entryCollateral)}</span>
                  {" · "}
                  Live collateral now: <span className="font-semibold">{fmtUsd(collateralBefore)}</span>
                  {fetchedAt && <span className="text-slate-400"> · as of {fetchedAt}</span>}
                </span>
                {!started && onRefresh && (
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white disabled:opacity-50"
                  >
                    ↻ Refresh
                  </button>
                )}
              </div>

              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th className="pb-1.5 font-medium">Instrument</th>
                    <th className="pb-1.5 font-medium">Side</th>
                    <th className="pb-1.5 font-medium text-right">Size</th>
                    <th className="pb-1.5 font-medium text-right">Entry</th>
                    <th className="pb-1.5 font-medium text-right">Mark (live)</th>
                    <th className="pb-1.5 font-medium text-right">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const entry = entryFor(p);
                    return (
                      <tr key={p.instrument_name} className="border-t border-slate-100">
                        <td className="py-1.5 font-mono">{p.instrument_name}</td>
                        <td className={`py-1.5 font-semibold ${p.direction === "buy" ? "text-emerald-600" : "text-red-600"}`}>
                          {p.direction === "buy" ? "LONG" : "SHORT"}
                        </td>
                        <td className="py-1.5 text-right">{Math.abs(p.size)}</td>
                        <td className="py-1.5 text-right text-slate-500">
                          {entry.price != null ? Number(entry.price).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
                        </td>
                        <td className="py-1.5 text-right">
                          {p.mark_price != null ? p.mark_price.toFixed(4) : "—"}
                        </td>
                        <td className={`py-1.5 text-right font-semibold ${p.floating_profit_loss >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {p.floating_profit_loss != null ? `$${p.floating_profit_loss.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          {!started && positions.length > 0 && (
            <SpreadExitPanel
              positions={positions}
              targets={spreadTargets}
              onTargetChange={onSpreadTargetChange}
            />
          )}

          {!started && positions.length > 0 && (
            <div className="rounded-lg border border-slate-200 px-3 py-2.5 space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-slate-700">
                <span className="font-medium">Cross the spread if unfilled after</span>
                <input
                  type="number" min="0" step="1" placeholder="never"
                  value={crossAfter ?? ""}
                  onChange={(e) => onCrossAfterChange?.(e.target.value)}
                  className="w-20 rounded border border-slate-200 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                />
                <select
                  value={crossAfterUnit ?? "sec"}
                  onChange={(e) => onCrossAfterUnitChange?.(e.target.value)}
                  className="rounded border border-slate-200 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                >
                  <option value="sec">seconds</option>
                  <option value="min">minutes</option>
                </select>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Legs close as maker orders chased at mark, which costs nothing but only fills if the market
                comes to you. After the time above, a still-unfilled leg is re-placed at the opposite touch
                (paying the ask to buy, hitting the bid to sell) so it fills straight away — a limit order, so
                the touch is a hard bound on the price. Leave blank to stay maker-only indefinitely.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            {started ? "Close" : "Cancel"}
          </button>
          {!started && positions.length > 0 && (
            <button
              onClick={onConfirm}
              disabled={confirming || loading}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {confirming ? "Starting…" : `Confirm — Close ${positions.length} Position${positions.length > 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

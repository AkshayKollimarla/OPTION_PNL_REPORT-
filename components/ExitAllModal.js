"use client";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

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

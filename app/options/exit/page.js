"use client";

import { useState, useEffect } from "react";
import ExitAllModal from "../../../components/ExitAllModal";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

// "2026-08-01" → "01AUG2026" — display only, not a Deribit instrument name
// (Deribit itself doesn't zero-pad single-digit days in instrument names).
function formatExpiry(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d)) return dateStr;
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day}${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear()}`;
}

// Lists every OPEN strategy (options_trades.status = 'open'), grouped by
// account + token — a single Exit closes EVERYTHING Deribit has open for
// that coin on that account at once, so the button is scoped per group, not
// per individual saved strategy row (several open strategies can share the
// same live position, e.g. two different strikes on the same SOL account).
export default function OptionsExitPage() {
  const [accounts, setAccounts] = useState([]);
  const [trades,   setTrades]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const [exitGroup,      setExitGroup]      = useState(null); // { account_id, token, trades }
  const [exitLoading,    setExitLoading]    = useState(false);
  const [exitError,      setExitError]      = useState(null);
  const [exitPositions,  setExitPositions]  = useState([]);
  const [exitConfirming, setExitConfirming] = useState(false);
  const [exitJob,        setExitJob]        = useState(null);
  const [collateralBefore, setCollateralBefore] = useState(null);
  const [fetchedAt,        setFetchedAt]        = useState(null);
  const [badIp,            setBadIp]            = useState(false);
  // Blank = stay maker-only forever (original behavior).
  const [crossAfter,       setCrossAfter]       = useState("");
  const [crossAfterUnit,   setCrossAfterUnit]   = useState("sec");
  const crossAfterSecs = crossAfter === "" || crossAfter == null
    ? null
    : Math.max(0, Math.round(Number(crossAfter))) * (crossAfterUnit === "min" ? 60 : 1);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [tRes, aRes] = await Promise.all([
        fetch("/api/options/trades?status=open&limit=9999"),
        fetch("/api/accounts"),
      ]);
      const [tData, aData] = await Promise.all([tRes.json(), aRes.json()]);
      if (!tRes.ok) throw new Error(tData.error || "Failed to load open strategies");
      setTrades(tData.trades || []);
      setAccounts(aData.accounts || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const accountName = (id) => accounts.find(a => a.id === id)?.name || `Account #${id}`;

  const groupMap = {};
  for (const t of trades) {
    const key = `${t.account_id}::${(t.token || "").toUpperCase()}`;
    if (!groupMap[key]) groupMap[key] = { account_id: t.account_id, token: t.token, trades: [] };
    groupMap[key].trades.push(t);
  }
  // Deribit-linked groups first, unlinked ones after. A group with no
  // account_id has no exchange behind it, so its Exit button can't fetch
  // positions or close anything — those belong below the ones that work,
  // not interleaved among them. Within each half, order by account then
  // token so the list stays stable across reloads.
  const groups = Object.values(groupMap).sort((a, b) => {
    const aLinked = a.account_id != null;
    const bLinked = b.account_id != null;
    if (aLinked !== bLinked) return aLinked ? -1 : 1;
    const byAccount = accountName(a.account_id).localeCompare(accountName(b.account_id));
    if (byAccount !== 0) return byAccount;
    return (a.token || "").localeCompare(b.token || "");
  });

  async function openExit(group) {
    setExitGroup(group);
    setExitJob(null);
    setExitError(null);
    setExitLoading(true);
    try {
      const r = await fetch(`/api/deribit-positions?account_id=${group.account_id}&token=${(group.token || "").toUpperCase()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to fetch live positions");
      setExitPositions(d.positions || []);
      setCollateralBefore(d.collateral ?? null);
      setBadIp(!!d.badIp);
      setFetchedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setExitError(e.message);
      setExitPositions([]);
    } finally {
      setExitLoading(false);
    }
  }

  async function confirmExit() {
    setExitConfirming(true);
    setExitError(null);
    try {
      // Positions are deliberately NOT sent: the server re-reads them at job
      // creation so the close is sized against live state, not against a
      // snapshot taken before the user read the dialog.
      const r = await fetch("/api/deribit-exit-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: exitGroup.account_id,
          token: (exitGroup.token || "").toUpperCase(),
          cross_after_secs: crossAfterSecs,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Exit failed");
      setExitJob(d);
    } catch (e) {
      setExitError(e.message);
    } finally {
      setExitConfirming(false);
    }
  }

  return (
    <div>
      <header className="flex h-16 items-center border-b border-slate-200 bg-white px-6">
        <h1 className="text-lg font-bold text-slate-800">Options Exit</h1>
      </header>

      <div className="p-6 space-y-4">
        {loading && <p className="text-sm text-slate-500">Loading open strategies…</p>}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
            No open strategies right now.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {groups.map((g) => {
            // No account_id means there's no exchange behind this group —
            // nothing to fetch positions from and nothing to close. The
            // button is disabled rather than left live so a click can't fail
            // with an opaque error on what looks like a working control.
            const linked = g.account_id != null;
            return (
            <div key={`${g.account_id}::${g.token}`} className={`rounded-xl border p-5 shadow-card ${linked ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {(g.token || "").toUpperCase()}{" "}
                    <span className="text-slate-500 font-normal">
                      · {linked ? accountName(g.account_id) : "No exchange account linked"}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {g.trades.length} open strateg{g.trades.length > 1 ? "ies" : "y"}
                    {!linked && " · manual only — link an account to enable Exit"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openExit(g)}
                  disabled={!linked}
                  title={linked ? undefined : "This strategy has no exchange account linked, so there are no live positions to fetch or close."}
                  className={`rounded-lg border-2 px-4 py-2 text-sm font-semibold transition-colors ${
                    linked
                      ? "border-red-600 bg-white text-red-600 hover:bg-red-50"
                      : "border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}
                >
                  ✕ Exit All Positions
                </button>
              </div>
              <div className="mt-3 divide-y divide-slate-100">
                {g.trades.map((t) => (
                  <div key={t.id} className="py-2 text-xs text-slate-600">
                    <div className="flex items-center justify-between">
                      <span>
                        {t.option_type} {t.options_strike} · exp {formatExpiry(t.expiry)}
                        {t.opt_entry_qty ? ` · ${t.opt_entry_qty}x` : ""}
                      </span>
                      <span className="text-slate-500">entered {formatExpiry(t.entry_date)}</span>
                    </div>
                    {!!t.fut_qty && (
                      <div className="mt-0.5 text-slate-600">
                        Futures ({t.fut_instrument_type || "—"}): {t.fut_qty}x
                        {t.fut_entry_price ? ` @ $${Number(t.fut_entry_price).toLocaleString()}` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {exitGroup && (
        <ExitAllModal
          token={exitGroup.token}
          trades={exitGroup.trades}
          loading={exitLoading}
          error={exitError}
          positions={exitPositions}
          confirming={exitConfirming}
          job={exitJob}
          collateralBefore={collateralBefore}
          fetchedAt={fetchedAt}
          badIp={badIp}
          crossAfter={crossAfter}
          crossAfterUnit={crossAfterUnit}
          onCrossAfterChange={setCrossAfter}
          onCrossAfterUnitChange={setCrossAfterUnit}
          onConfirm={confirmExit}
          onRefresh={() => openExit(exitGroup)}
          onClose={() => {
            setExitGroup(null);
            setCollateralBefore(null);
            setFetchedAt(null);
            setBadIp(false);
            load();
          }}
        />
      )}
    </div>
  );
}

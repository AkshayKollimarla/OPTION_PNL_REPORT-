"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { spotRowIndex, windowRows } from "../lib/option-chain";

/* ── formatting ───────────────────────────────────────────── */

const fmtPx = (v) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  // Premiums get finer than cents on cheap contracts, and rounding a 0.005
  // market to 0.01 doubles it.
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
};
const fmtIv = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(2)}%`);
const fmtDelta = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));
const fmtInt = (v) => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString());
const fmtDist = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));

const SIDES = { BID: "SHORT", ASK: "LONG" };

/* ── one half of a bid × ask cell ─────────────────────────── */

/**
 * Clicking a price is an order, so the two halves are separate buttons: the
 * bid is where you sell and the ask is where you buy, and a cell that took one
 * click for both would make the difference a mode rather than a place.
 *
 * Selected, they take the colour of what they did -- green for the side sold,
 * red for the side bought -- rather than one highlight for "chosen", which
 * would leave the two legs of a spread looking identical.
 */
function PriceHalf({ value, kind, selected, disabled, onPick, title }) {
  const tone = selected
    ? (kind === "BID"
        ? "bg-emerald-100 text-emerald-800 font-bold ring-1 ring-emerald-400"
        : "bg-red-100 text-red-800 font-bold ring-1 ring-red-400")
    : "hover:bg-slate-100 text-slate-600";
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || value === null || value === undefined}
      onClick={onPick}
      className={`w-[52px] rounded px-1 py-0.5 text-right tabular-nums transition-colors disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${tone}`}
    >
      {fmtPx(value)}
    </button>
  );
}

/* ── one side of one strike ───────────────────────────────── */

function SideCells({ side, optType, strike, expiry, mirrored, pickedOf, onPick, dense }) {
  const s = side || {};
  const sel = (kind) => pickedOf(optType, SIDES[kind], strike);

  const price = (
    <td key="price" className="px-1 py-0.5 whitespace-nowrap">
      <span className="inline-flex items-center gap-0.5">
        <PriceHalf value={s.bid} kind="BID" selected={sel("BID")}
          title={`Sell ${optType.toLowerCase()} ${strike} at the bid`}
          onPick={() => onPick({ optType, side: "SHORT", strike, expiry, price: s.bid, iv: s.iv })} />
        <span className="text-[10px] text-slate-300">×</span>
        <PriceHalf value={s.ask} kind="ASK" selected={sel("ASK")}
          title={`Buy ${optType.toLowerCase()} ${strike} at the ask`}
          onPick={() => onPick({ optType, side: "LONG", strike, expiry, price: s.ask, iv: s.iv })} />
      </span>
    </td>
  );

  const cell = (k, v, extra = "") => (
    <td key={k} className={`px-2 py-0.5 text-right tabular-nums text-slate-500 ${extra}`}>{v}</td>
  );
  const by = {
    delta: cell("delta", fmtDelta(s.delta)),
    be: cell("be", fmtPx(s.be)),
    iv: cell("iv", fmtIv(s.iv)),
    theor: cell("theor", fmtPx(s.theor), "font-semibold text-slate-700"),
    price,
    dist: cell("dist", fmtDist(s.distance)),
    vol: cell("vol", fmtInt(s.volume)),
    oi: cell("oi", fmtInt(s.oi)),
  };

  // The puts read outward from the strike, so their columns run the other way.
  const order = mirrored
    ? ["oi", "vol", "dist", "price", "theor", "iv", "be", "delta"]
    : ["delta", "be", "iv", "theor", "price", "dist", "vol", "oi"];
  return <>{order.map((k) => by[k])}</>;
}

/* ── the grid ─────────────────────────────────────────────── */

const WINDOWS = [
  { n: 4, label: "±4 strikes" },
  { n: 6, label: "±6 strikes" },
  { n: 10, label: "±10 strikes" },
  { n: 0, label: "All strikes" },
];

/**
 * An option chain that can be clicked into a strategy.
 *
 * @param picked      [{ optType, side, strike, expiry }] already in the structure
 * @param onPick      called with a contract when a price is clicked
 * @param expiries    [{ date, label }] for the dropdown
 */
export default function OptionChainGrid({
  accountId, token, expiry, expiries = [], onExpiryChange, picked = [], onPick, pollMs = 2000,
}) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState("both");
  const [win, setWin] = useState(6);
  const [open, setOpen] = useState(true);

  const canLoad = !!accountId && !!token && !!expiry;
  // Serialised so the effect restarts on a real change of contract, not on
  // every render that happens to rebuild the same props.
  const key = `${accountId}|${token}|${expiry}`;

  useEffect(() => {
    if (!canLoad) { setData(null); setErr(null); return undefined; }
    let stopped = false;
    let first = true;

    const poll = async () => {
      // A chain nobody is looking at is a request nobody reads.
      if (typeof document !== "undefined" && document.hidden) return;
      if (first) setLoading(true);
      try {
        const [acct, tkn, exp] = key.split("|");
        const res = await fetch(
          `/api/options/chain-quotes?account_id=${encodeURIComponent(acct)}&token=${encodeURIComponent(tkn)}&expiry=${encodeURIComponent(exp)}`,
          { cache: "no-store" });
        const j = await res.json();
        if (stopped) return;
        if (j.error) { setErr(j.error); if (!j.rows?.length) setData(null); }
        else { setErr(null); setData(j); }
      } catch (e) {
        if (!stopped) setErr(e.message);
      } finally {
        if (!stopped && first) { setLoading(false); first = false; }
      }
    };

    poll();
    const t = setInterval(poll, pollMs);
    return () => { stopped = true; clearInterval(t); };
  }, [canLoad, key, pollMs]);

  // Rows carry their own distance already; the window is taken around spot.
  const rows = useMemo(
    () => windowRows(data?.rows || [], data?.underlying, win),
    [data, win]);

  const spotAt = useMemo(() => spotRowIndex(rows, data?.underlying), [rows, data]);

  const pickedOf = useCallback((optType, side, strike) =>
    picked.some((p) => p.optType === optType && p.side === side
      && Number(p.strike) === Number(strike) && p.expiry === expiry),
    [picked, expiry]);

  const cols = show === "both" ? 17 : 9;
  const showCalls = show !== "puts";
  const showPuts = show !== "calls";

  const stale = useMemo(() => {
    if (!data?.quoteAt) return null;
    const age = Date.now() - Date.parse(data.quoteAt);
    // Ten minutes: longer than any gap inside a live session, short enough to
    // catch a chain still showing the previous close.
    return age > 10 * 60 * 1000 ? data.quoteAt : null;
  }, [data]);

  if (!canLoad) {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-xs text-slate-400">
        Pick an account, a token and an expiry to load the chain.
      </div>
    );
  }

  const h = (side) => (label, extra = "") => (
    <th key={`${side}-${label}`}
      className={`px-2 py-1 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-400 ${extra}`}>
      {label}
    </th>
  );
  const hc = h("c"), hp = h("p");
  const callHeads = [hc("Delta"), hc("BE"), hc("IV"), hc("Theor"), hc("Bid × Ask", "text-center"), hc("Distance"), hc("Volume"), hc("Open int")];
  const putHeads = [hp("Open int"), hp("Volume"), hp("Distance"), hp("Bid × Ask", "text-center"), hp("Theor"), hp("IV"), hp("BE"), hp("Delta")];

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        <select value={expiry || ""} onChange={(e) => onExpiryChange?.(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
          {!expiries.length && <option value={expiry}>{expiry}</option>}
          {expiries.map((e) => <option key={e.date} value={e.date}>{e.label || e.date}</option>)}
        </select>

        <select value={win} onChange={(e) => setWin(Number(e.target.value))}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
          {WINDOWS.map((w) => <option key={w.n} value={w.n}>{w.label}</option>)}
        </select>

        {loading && <span className="text-[11px] text-slate-400 animate-pulse">Loading chain…</span>}
        {!loading && data && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            live · {data.venue}
          </span>
        )}

        <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-slate-200">
          {[["calls", "Calls"], ["puts", "Puts"], ["both", "Calls and puts"]].map(([v, label]) => (
            <button key={v} type="button" onClick={() => setShow(v)}
              className={`px-2.5 py-1 text-xs font-semibold transition-colors ${
                show === v ? "bg-slate-800 text-white" : "bg-white text-slate-500 hover:bg-slate-100"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">{err}</div>
      )}
      {stale && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800">
          These quotes last moved at {new Date(stale).toLocaleString()} — the options market is closed, so they
          are the previous session&apos;s. The underlying price above them is live, so the two will not agree.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-100">
              {showCalls && <th colSpan={8} className="py-1 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Calls</th>}
              <th className="py-1" />
              {showPuts && <th colSpan={8} className="py-1 text-center text-[11px] font-bold uppercase tracking-wide text-slate-500">Puts</th>}
            </tr>
            <tr className="border-b border-slate-200">
              {showCalls && callHeads}
              <th className="px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">Strike</th>
              {showPuts && putHeads}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-slate-100/70">
              <td colSpan={cols} className="px-2 py-1">
                <button type="button" onClick={() => setOpen((o) => !o)}
                  className="flex items-center gap-2 text-[11px] font-bold text-slate-600">
                  <span className="text-slate-400">{open ? "▾" : "▸"}</span>
                  {data?.expiry ? new Date(`${data.expiry}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" }) : expiry}
                  {data?.dte !== null && data?.dte !== undefined && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{data.dte} DTE</span>
                  )}
                </button>
              </td>
            </tr>

            {open && rows.map((r, i) => (
              <Fragment key={r.strike}>
                  {i === spotAt && data?.underlying != null && <SpotBand cols={cols} token={data.token} price={data.underlying} />}
                  <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-100">
                    {showCalls && (
                      <SideCells side={r.call && { ...r.call, distance: r.distance }} optType="CALL" strike={r.strike}
                        expiry={expiry} pickedOf={pickedOf} onPick={onPick} />
                    )}
                    <td className="px-2 py-0.5 text-center font-bold tabular-nums text-slate-700">{r.strike}</td>
                    {showPuts && (
                      <SideCells side={r.put && { ...r.put, distance: r.distance }} optType="PUT" strike={r.strike}
                        expiry={expiry} mirrored pickedOf={pickedOf} onPick={onPick} />
                    )}
                  </tr>
              </Fragment>
            ))}

            {open && spotAt === rows.length && data?.underlying != null && (
              <SpotBand cols={cols} token={data.token} price={data.underlying} />
            )}

            {open && !rows.length && !loading && (
              <tr><td colSpan={cols} className="px-3 py-4 text-center text-xs text-slate-400">
                No strikes listed for this expiry.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The underlying, drawn between the strikes it sits between rather than on one
 * of them -- which is what makes the rows above and below read as in and out
 * of the money without anything having to say so.
 */
function SpotBand({ cols, token, price }) {
  return (
    <tr className="bg-indigo-50">
      <td colSpan={cols} className="px-2 py-1">
        <div className="flex items-center gap-2">
          <span className="h-px flex-1 bg-indigo-200" />
          <span className="whitespace-nowrap text-[11px] font-bold text-indigo-700">
            {token} {Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD
          </span>
          <span className="h-px flex-1 bg-indigo-200" />
        </div>
      </td>
    </tr>
  );
}

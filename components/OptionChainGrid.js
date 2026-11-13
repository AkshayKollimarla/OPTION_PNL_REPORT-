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

/* ── the two prices, and the premium under them ───────────── */

/**
 * Bid and ask sit apart, each its own target, with the premium centred
 * underneath. They were one cramped "bid × ask" before, which made the pair
 * hard to hit and hard to read as two different things: the bid is where you
 * sell and the ask is where you buy.
 *
 * They carry their colours all the time, not only once chosen -- green for the
 * side you sell at, red for the side you buy at -- so the chain reads the same
 * way whether or not anything is selected. Picking one fills it in.
 */
function PriceCell({ side, optType, strike, expiry, pickedOf, onPick }) {
  const s = side || {};
  const half = (kind, value, dir) => {
    const on = pickedOf(optType, dir, strike);
    const tone = kind === "BID"
      ? (on ? "bg-emerald-100 text-emerald-800 font-bold ring-1 ring-emerald-400" : "text-emerald-700 hover:bg-emerald-50")
      : (on ? "bg-red-100 text-red-800 font-bold ring-1 ring-red-400" : "text-red-700 hover:bg-red-50");
    return (
      <button
        type="button"
        title={`${kind === "BID" ? "Sell" : "Buy"} ${optType.toLowerCase()} ${strike} at the ${kind.toLowerCase()}`}
        disabled={value === null || value === undefined}
        onClick={() => onPick({ optType, side: dir, strike, expiry, price: value, iv: s.iv })}
        className={`${PRICE_W} rounded px-1.5 py-0.5 text-center text-[13px] font-semibold tabular-nums transition-colors disabled:cursor-default disabled:text-slate-400 disabled:hover:bg-transparent ${tone}`}
      >
        {fmtPx(value)}
      </button>
    );
  };

  return (
    <td className="px-2 py-1 align-middle">
      <div className="flex flex-col items-center gap-0.5">
        <div className={`flex items-center ${PRICE_GAP}`}>
          {half("BID", s.bid, "SHORT")}
          {half("ASK", s.ask, "LONG")}
        </div>
        {/* The premium those two sides imply, directly under them. */}
        <span className="text-[11px] tabular-nums text-slate-500">{fmtPx(s.theor)}</span>
      </div>
    </td>
  );
}

/* ── short / long, revealed on hover ──────────────────────── */

/**
 * The two sides as named actions, next to the strike.
 *
 * The prices above are already clickable -- the bid sells, the ask buys -- but
 * that has to be known before the chain can be used. These say it outright.
 * They are the same two actions and carry the same two prices, so a Short here
 * and a click on the bid are one thing.
 *
 * Hidden until the row is hovered, so eighty rows of buttons do not compete
 * with the numbers, and shown permanently once a leg sits on that contract:
 * a position is state worth seeing without hunting for it. They also appear on
 * keyboard focus, or they could never be reached without a mouse.
 */
function PositionCell({ side, optType, strike, expiry, pickedOf, onPick }) {
  const s = side || {};
  const isShort = pickedOf(optType, "SHORT", strike);
  const isLong = pickedOf(optType, "LONG", strike);
  const held = isShort || isLong;

  const btn = (dir, label, price, on, tone) => (
    <button
      type="button"
      disabled={price === null || price === undefined}
      title={`${dir === "SHORT" ? "Sell" : "Buy"} ${optType.toLowerCase()} ${strike} at ${fmtPx(price)}`}
      onClick={() => onPick({ optType, side: dir, strike, expiry, price, iv: s.iv })}
      className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold transition-colors disabled:cursor-default disabled:border-slate-200 disabled:bg-white disabled:text-slate-300 ${tone}`}
    >
      {label}
    </button>
  );

  return (
    <td className="px-2 py-1">
      <div className={`flex items-center justify-center gap-1 transition-opacity ${
        held ? "" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"}`}>
        {btn("SHORT", "Short", s.bid, isShort,
          isShort ? "border-red-200 bg-red-100 font-bold text-red-800 ring-1 ring-red-400"
                  : "border-red-200 bg-white text-red-700 hover:bg-red-100")}
        {btn("LONG", "Long", s.ask, isLong,
          isLong ? "border-blue-200 bg-blue-100 font-bold text-blue-700 ring-1 ring-blue-400"
                 : "border-blue-200 bg-white text-blue-700 hover:bg-blue-100")}
      </div>
    </td>
  );
}

/* ── one side of one strike ───────────────────────────────── */

function SideCells({ side, optType, strike, expiry, mirrored, pickedOf, onPick }) {
  const s = side || {};
  const cell = (k, v) => (
    <td key={k} className="px-2 py-1 text-right tabular-nums text-slate-600">{v}</td>
  );
  const by = {
    delta: cell("delta", fmtDelta(s.delta)),
    be: cell("be", fmtPx(s.be)),
    iv: cell("iv", fmtIv(s.iv)),
    price: <PriceCell key="price" side={side} optType={optType} strike={strike}
      expiry={expiry} pickedOf={pickedOf} onPick={onPick} />,
    position: <PositionCell key="position" side={side} optType={optType} strike={strike}
      expiry={expiry} pickedOf={pickedOf} onPick={onPick} />,
  };
  // The puts read outward from the strike, so their columns run the other way.
  // Position sits innermost on both sides, against the strike it belongs to.
  const order = mirrored
    ? ["position", "price", "iv", "be", "delta"]
    : ["delta", "be", "iv", "price", "position"];
  return <>{order.map((k) => by[k])}</>;
}

/* ── the grid ─────────────────────────────────────────────── */

// How many strikes either side of the money to draw. The wide settings are
// there for the wings -- a far out-of-the-money hedge can sit thirty strikes
// out, and before these existed the only way to reach it was "All strikes",
// which on a heavily listed name is several hundred rows.
const WINDOWS = [
  { n: 4, label: "±4 strikes" },
  { n: 6, label: "±6 strikes" },
  { n: 10, label: "±10 strikes" },
  { n: 20, label: "±20 strikes" },
  { n: 30, label: "±30 strikes" },
  { n: 50, label: "±50 strikes" },
  { n: 0, label: "All strikes" },
];

const COLS_PER_SIDE = 5;

// One number drives the price buttons and the BID / ASK labels above them.
const PRICE_W = "w-[62px]";
const PRICE_GAP = "gap-3";

/**
 * An option chain that can be clicked into a strategy.
 *
 * @param tokenControl the coin picker, rendered beside the expiry. Passed in
 *                     rather than built here: the page already owns one that
 *                     knows how to search symbols per venue.
 * @param picked       [{ optType, side, strike, expiry }] already in the structure
 * @param onPick       called with a contract when a price is clicked
 * @param onQuotes     called with each poll's payload, so the page can read
 *                     IVs and premiums off the same quotes the grid is showing
 */
export default function OptionChainGrid({
  accountId, token, expiry, expiries = [], onExpiryChange, tokenControl,
  picked = [], onPick, onQuotes, pollMs = 2000,
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
        else { setErr(null); setData(j); onQuotes?.(j); }
      } catch (e) {
        if (!stopped) setErr(e.message);
      } finally {
        if (!stopped && first) { setLoading(false); first = false; }
      }
    };

    poll();
    const t = setInterval(poll, pollMs);
    return () => { stopped = true; clearInterval(t); };
    // onQuotes deliberately absent from the deps: a parent that rebuilds the
    // callback each render would otherwise restart the poll every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, key, pollMs]);

  const rows = useMemo(
    () => windowRows(data?.rows || [], data?.underlying, win),
    [data, win]);

  const spotAt = useMemo(() => spotRowIndex(rows, data?.underlying), [rows, data]);

  const pickedOf = useCallback((optType, side, strike) =>
    picked.some((p) => p.optType === optType && p.side === side
      && Number(p.strike) === Number(strike) && p.expiry === expiry),
    [picked, expiry]);

  const showCalls = show !== "puts";
  const showPuts = show !== "calls";
  const cols = 1 + (showCalls ? COLS_PER_SIDE : 0) + (showPuts ? COLS_PER_SIDE : 0);

  const stale = useMemo(() => {
    if (!data?.quoteAt) return null;
    const age = Date.now() - Date.parse(data.quoteAt);
    // Ten minutes: longer than any gap inside a live session, short enough to
    // catch a chain still showing the previous close.
    return age > 10 * 60 * 1000 ? data.quoteAt : null;
  }, [data]);

  const h = (side) => (label) => (
    <th key={`${side}-${label}`}
      className="px-2 py-1 text-right text-[11px] font-bold uppercase tracking-wide text-slate-700">
      {label}
    </th>
  );
  const priceHead = (side) => (
    <th key={`${side}-price`} className="px-2 py-1">
      <div className={`flex items-center justify-center ${PRICE_GAP}`}>
        <span className={`${PRICE_W} text-center text-[11px] font-bold uppercase tracking-wide text-emerald-700`}>Bid</span>
        <span className={`${PRICE_W} text-center text-[11px] font-bold uppercase tracking-wide text-red-700`}>Ask</span>
      </div>
    </th>
  );
  const hc = h("c"), hp = h("p");
  const pos = (sideKey) => (
    <th key={`${sideKey}-position`}
      className="px-2 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-slate-700">
      Position
    </th>
  );
  const callHeads = [hc("Delta"), hc("BE"), hc("IV"), priceHead("c"), pos("c")];
  const putHeads = [pos("p"), priceHead("p"), hp("IV"), hp("BE"), hp("Delta")];

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50">
      {/* Controls. Coin and expiry sit together, because picking one almost
          always means picking the other. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2">
        {tokenControl && <div className="w-44">{tokenControl}</div>}

        <select value={expiry || ""} onChange={(e) => onExpiryChange?.(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
          {!expiries.length && <option value={expiry}>{expiry || "— expiry —"}</option>}
          {expiries.map((e) => <option key={e.date} value={e.date}>{e.label || e.date}</option>)}
        </select>

        <select value={win} onChange={(e) => setWin(Number(e.target.value))}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
          {WINDOWS.map((w) => <option key={w.n} value={w.n}>{w.label}</option>)}
        </select>

        {loading && <span className="text-[11px] text-slate-500 animate-pulse">Loading chain…</span>}
        {!loading && data && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
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

      {!canLoad ? (
        <div className="px-4 py-6 text-center text-xs text-slate-500">
          Pick an account, a coin and an expiry to load the chain.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-slate-100">
                {showCalls && <th colSpan={COLS_PER_SIDE} className="py-1 text-center text-xs font-bold uppercase tracking-wide text-slate-700">Calls</th>}
                <th className="py-1" />
                {showPuts && <th colSpan={COLS_PER_SIDE} className="py-1 text-center text-xs font-bold uppercase tracking-wide text-slate-700">Puts</th>}
              </tr>
              <tr className="border-b border-slate-200">
                {showCalls && callHeads}
                <th className="px-2 py-1 text-center text-[11px] font-bold uppercase tracking-wide text-slate-700">Strike</th>
                {showPuts && putHeads}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-slate-100">
                <td colSpan={cols} className="px-2 py-1">
                  <button type="button" onClick={() => setOpen((o) => !o)}
                    className="flex items-center gap-2 text-[11px] font-bold text-slate-600">
                    <span className="text-slate-600">{open ? "▾" : "▸"}</span>
                    {data?.expiry
                      ? new Date(`${data.expiry}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" })
                      : expiry}
                    {data?.dte !== null && data?.dte !== undefined && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">{data.dte} DTE</span>
                    )}
                  </button>
                </td>
              </tr>

              {open && rows.map((r, i) => (
                <Fragment key={r.strike}>
                  {i === spotAt && data?.underlying != null && <SpotBand cols={cols} token={data.token} price={data.underlying} />}
                  {/* `group` is what lets the Short/Long buttons appear for
                      the hovered row and no other. */}
                  <tr className="group border-b border-slate-100 last:border-0 hover:bg-slate-100">
                    {showCalls && (
                      <SideCells side={r.call} optType="CALL" strike={r.strike}
                        expiry={expiry} pickedOf={pickedOf} onPick={onPick} />
                    )}
                    <td className="px-2 py-1 text-center text-sm font-bold tabular-nums text-slate-800">{r.strike}</td>
                    {showPuts && (
                      <SideCells side={r.put} optType="PUT" strike={r.strike}
                        expiry={expiry} mirrored pickedOf={pickedOf} onPick={onPick} />
                    )}
                  </tr>
                </Fragment>
              ))}

              {open && spotAt === rows.length && data?.underlying != null && (
                <SpotBand cols={cols} token={data.token} price={data.underlying} />
              )}

              {open && !rows.length && !loading && (
                <tr><td colSpan={cols} className="px-3 py-4 text-center text-xs text-slate-500">
                  No strikes listed for this expiry.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
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

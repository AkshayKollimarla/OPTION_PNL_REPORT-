// One row per strike, calls on one side and puts on the other, the way a
// chain is read.
//
// Everything here is derived rather than fetched. A venue gives bid, ask and
// sometimes its own mark and IV; delta, break-even and distance are arithmetic
// on top of those, and doing it in one place means the call and the put at a
// strike cannot end up computed two different ways.
//
// Prices in and out are in one currency. Deribit quotes its inverse options in
// coin, so the caller converts before handing them over -- this file does not
// know which venue it is looking at.

import { bsDelta, impliedVol } from "./black-scholes.js";

const RISK_FREE = 0.05;

// null and "" are not zero. Number(null) is 0, which would turn a field the
// venue never sent -- Alpaca sends no open interest -- into a confident "0"
// on screen, and "no open interest" is a very different claim from "the venue
// did not say".
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Prices come back from two venues and several arithmetic steps; rounding at
// the point of display only would leave 2.1750000000000003 in an exported row.
const exact = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

/**
 * Whole days from `now` to the expiry, as a chain labels them.
 *
 * Counted from midnight UTC on both ends, so a chain opened at nine in the
 * morning and again at four in the afternoon says the same number. Counting
 * from the current moment would tick a 4 DTE row over to 3 DTE midway through
 * an afternoon, which is not how anyone reads an expiry.
 */
export function dteOf(expiry, now = new Date()) {
  const exp = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(exp)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((exp - today) / 86400000));
}

/**
 * The price a side is worked from: the mid of a two-sided market.
 *
 * Half a book is not a price. Where only one side is quoted the venue's own
 * mark is used if it published one, and otherwise there is no price -- never
 * the bid alone, which would read as the option being worth what someone is
 * willing to pay rather than what it is worth.
 */
export function theorOf({ bid, ask, mark }) {
  const b = num(bid), a = num(ask), m = num(mark);
  if (b > 0 && a > 0) return exact((b + a) / 2);
  return m > 0 ? exact(m) : null;
}

/**
 * One side of one strike, with everything the grid shows.
 *
 * `iv` from the venue is preferred over solving for it: Deribit publishes a
 * mark IV computed off its own mark, and showing a different number beside its
 * price would be this page disagreeing with the venue about its own option.
 * Where the venue publishes none -- Alpaca does not, on this feed -- it is
 * solved from the mid.
 *
 * A solved IV will not match the IV column on a broker's chain, and is not
 * meant to. Those are read off a fitted surface, smoothed across strikes; this
 * is the volatility that prices THIS option at THIS mid, and nothing else.
 */
export function sideOf(q, { strike, underlying, T, type }) {
  if (!q) return null;
  const theor = theorOf(q);
  const S = num(underlying), K = num(strike);

  const venueIv = num(q.iv);
  const iv = venueIv > 0 ? venueIv / 100
    : (theor !== null && S && K && T > 0 ? impliedVol(theor, S, K, T, RISK_FREE, type) : null);

  // Break-even is where the option has paid for itself at expiry: the strike
  // plus what it cost, the other way round for a put. Without a price there
  // is nothing to pay back and no break-even to quote.
  const be = theor === null || !K ? null
    : exact(type === "CALL" ? K + theor : K - theor);

  return {
    bid: num(q.bid) > 0 ? exact(num(q.bid)) : null,
    ask: num(q.ask) > 0 ? exact(num(q.ask)) : null,
    theor,
    iv: iv === null ? null : Math.round(iv * 1e4) / 1e4,
    delta: iv && S && K ? Math.round(bsDelta(S, K, T, RISK_FREE, iv, type) * 100) / 100 : null,
    be,
    volume: num(q.volume),
    oi: num(q.oi),
    instrument: q.instrument || null,
  };
}

/**
 * @param contracts [{ strike, optType, bid, ask, mark, iv, volume, oi, instrument }]
 * @param underlying spot price of the thing the options are on
 * @param expiry     YYYY-MM-DD
 * @returns [{ strike, distance, call, put }] ascending by strike
 */
export function buildChainRows({ contracts, underlying, expiry, now = new Date() }) {
  const dte = dteOf(expiry, now);
  // Years, and never zero on the day itself: an option expiring today still
  // has hours of life in it, and T=0 would price every one of them at
  // intrinsic and solve every IV to nothing.
  const T = dte === null ? 0 : Math.max(dte, 0.5) / 365;
  const S = num(underlying);

  const byStrike = new Map();
  for (const c of contracts || []) {
    const strike = num(c?.strike);
    if (!strike || strike <= 0) continue;
    const call = String(c.optType || "").toUpperCase().startsWith("C");
    if (!byStrike.has(strike)) byStrike.set(strike, { strike, call: null, put: null });
    byStrike.get(strike)[call ? "call" : "put"] = c;
  }

  return [...byStrike.values()]
    .sort((a, b) => a.strike - b.strike)
    .map(({ strike, call, put }) => ({
      strike,
      // How far the underlying would have to travel to reach this strike.
      // Unsigned, as a chain shows it -- which side it is on is already
      // obvious from where the row sits relative to the spot marker.
      distance: S ? exact(Math.abs(S - strike)) : null,
      call: sideOf(call, { strike, underlying: S, T, type: "CALL" }),
      put: sideOf(put, { strike, underlying: S, T, type: "PUT" }),
    }));
}

/**
 * Where the spot marker goes: the index of the first row at or above the
 * underlying, so the grid can draw the price between two strikes rather than
 * through one.
 *
 * Returns rows.length when every strike is below spot, and 0 when every one is
 * above, which puts the marker at the end or the start rather than nowhere.
 */
export function spotRowIndex(rows, underlying) {
  const S = num(underlying);
  if (!S || !rows?.length) return -1;
  const i = rows.findIndex((r) => r.strike >= S);
  return i === -1 ? rows.length : i;
}

/**
 * The `n` strikes either side of the money, which is how a chain is read --
 * the far wings are listed but nobody is looking at them.
 *
 * `n` of 0 means all of them.
 */
export function windowRows(rows, underlying, n) {
  if (!n || !rows?.length) return rows || [];
  const at = spotRowIndex(rows, underlying);
  if (at < 0) return rows;
  return rows.slice(Math.max(0, at - n), at + n);
}

// What a structure makes at the two prices it was built around -- taken from
// the strategy itself, not recalculated from the market.
//
// Two questions, and the gap between them is the point:
//
//   at expiry   the price finishes at the target. The options are worth
//               their intrinsic value and nothing else. This is the plan,
//               and it is the number ALREADY SAVED on the strategy --
//               estimated_upside_net_pnl and its downside twin, the same
//               figures the Options Dashboard shows.
//   today       the same price reached now, with every option still
//               carrying its time value. Routinely far worse on the side
//               the short strikes are on, and the figure that actually
//               shows up in the account if the coin gets there this
//               afternoon.
//
// EVERY INPUT HERE IS RECORDED, NOT LIVE. That is deliberate and it is the
// whole character of this file. An earlier version solved each leg's
// volatility from its live quote, which was more accurate and made the
// "today" figure move every second -- a planning number that will not sit
// still is not a planning number, and it disagreed with the simulator
// besides. So the volatility is the leg's own recorded IV, the target is the
// recorded futures price plus or minus the recorded distance, and the expiry
// figure is simply read off the row. The only thing that moves is the time
// left, which moves once a day.
//
// This mirrors the simulator's scenario block exactly, down to the fallback
// volatility, so one structure reads the same in both places.

import { expiryPnl, currentPnl } from "./black-scholes.js";

const RISK_FREE = 0.05;

// What the simulator falls back to for a leg carrying no volatility.
const DEFAULT_IV = 0.30;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const exact = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

/**
 * Whole days from today to the expiry date, floored at zero.
 *
 * Day granularity, as everywhere else in this book. On the expiry date itself
 * this gives nothing left, so "today" collapses onto "at expiry" -- correct
 * rather than a shortfall: on the day, today IS expiry.
 */
export function daysToExpiry(expiry, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry || ""));
  if (!m) return null;
  // Both ends at local midnight, so the subtraction is whole days and cannot
  // be dragged across a boundary by the time of day or by a UTC offset.
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/**
 * The volatility a leg's "today" value is priced with.
 *
 * The leg's own recorded IV, stored as a percentage. Nothing live: see the
 * note at the top of the file. A leg that never had one priced at a flat 30%
 * is a guess, and `assumed` below counts those so the card can say so rather
 * than presenting a guess as a measurement.
 */
export function volFor(storedIv) {
  const stored = num(storedIv);
  if (stored !== null && stored > 0) return { iv: Math.max(0.01, stored / 100), assumed: false };
  return { iv: DEFAULT_IV, assumed: true };
}

/**
 * One side of a structure.
 *
 * @param legs shaped legs carrying the saved columns
 * @param side "up" or "down"
 */
export function sideAt({ legs, side, now = new Date() }) {
  const up = side === "up";

  let savedNet = 0;      // the expiry figure, read off the rows
  let bsOpt = 0;         // what the options are worth there TODAY
  let fut = 0;           // the hedge, as recorded for that side
  let mm = 0;
  let counted = 0;
  let assumed = 0;
  let target = null;

  for (const l of legs || []) {
    const s = l?.saved || {};

    // Read first, so a structure still reports its expiry figure even where
    // a leg carries no option quantity to model today with.
    const net = num(up ? s.upside_net : s.downside_net);
    if (net !== null) { savedNet += net; counted++; }
    fut += num(up ? s.upside_fut : s.downside_fut) ?? 0;
    mm += num(s.mm) ?? 0;

    // The price this side was built around: the recorded futures entry, plus
    // or minus the recorded distance. NOT the short strike -- those differ on
    // 74 of 81 structures on this book, which is why the card prints the
    // target beside these figures rather than leaving it to be assumed.
    const futPx = num(s.fut_entry_price);
    const dist = num(up ? s.upside_distance : s.down_distance);
    const legTarget = futPx !== null && dist !== null
      ? exact(up ? futPx + dist : futPx - dist)
      : null;
    if (legTarget !== null && target === null) target = legTarget;

    const qty = num(l?.form?.opt_entry_qty);
    const entry = num(l?.form?.opt_entry_price);
    const strike = num(l?.contract?.strike);
    if (qty === null || qty === 0 || entry === null || strike === null || strike <= 0) continue;
    if (legTarget === null || legTarget <= 0) continue;

    const optType = String(l.contract.optType || "").toUpperCase().startsWith("C") ? "CALL" : "PUT";
    const days = daysToExpiry(l.contract.expiry, now);
    const years = days === null ? 0 : days / 365;

    if (years > 0) {
      const v = volFor(l.iv);
      if (v.assumed) assumed++;
      bsOpt += currentPnl(legTarget, strike, years, RISK_FREE, v.iv, optType, entry, qty);
    } else {
      // Nothing left to model: the payoff IS the value.
      bsOpt += expiryPnl(legTarget, strike, optType, entry, qty);
    }
  }

  if (!counted) return null;

  return {
    target,
    // Read straight off the strategy. Already the whole picture for that
    // side -- options, hedge and market-making loss -- which is why nothing
    // is added to it here.
    expiry: exact(savedNet),
    // Rebuilt the way the simulator rebuilds it: the options revalued at the
    // target with time still on them, plus the same recorded hedge and
    // market-making figures the expiry number uses.
    today: exact(bsOpt + fut + mm),
    optToday: exact(bsOpt),
    fut: exact(fut),
    mm: exact(mm),
    assumed,
  };
}

/** Both sides. Either may be null. */
export function scenarios({ legs, now = new Date() }) {
  const upside = sideAt({ legs, side: "up", now });
  const downside = sideAt({ legs, side: "down", now });
  if (!upside && !downside) return null;
  return { upside, downside };
}

export { RISK_FREE, DEFAULT_IV };

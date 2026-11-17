// What a structure makes if the coin reaches one of its limits.
//
// Two questions, not one, and the gap between them is the point:
//
//   at expiry   the price finishes at the limit. The options are worth their
//               intrinsic value and nothing else -- this is the plan, the
//               number the structure was built to produce.
//   today       the price is at the limit NOW, weeks early, with every
//               option still carrying its time value. This is what the
//               account actually shows if it gaps there this afternoon, and
//               it is routinely far worse than the expiry figure on the side
//               the short strikes are on.
//
// A structure can be comfortably profitable at expiry and deeply underwater
// today at the very same price. Showing only the first is what makes a limit
// being touched feel like a surprise.
//
// Valued at the card's OWN limits -- the short strikes it draws above these
// figures -- so "upside" means the number printed two lines up and not some
// other price derived from the recorded distances. Those distances are
// rounded to one decimal when they are stored and are only a fallback here,
// exactly as they are for the band itself.

import { bsPrice, expiryPnl, currentPnl, impliedVol } from "./black-scholes.js";
import { futuresPnl } from "./spread-price.js";

const RISK_FREE = 0.05;

// What the simulator falls back to when a leg carries no volatility, kept the
// same so a structure reads the same in both places.
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
 * this gives nothing left, so "today" collapses onto "at expiry" -- which is
 * correct rather than a shortfall: on the day, today IS expiry.
 */
export function daysToExpiry(expiry, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry || ""));
  if (!m) return null;
  // Both ends at local midnight, so the subtraction is whole days and cannot
  // be dragged over a boundary by the time of day or by a UTC offset.
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/**
 * The volatility to price a leg's "today" value with.
 *
 * Taken from the leg's own live quote wherever one can be solved: that is the
 * market's current view of THIS strike, so the skew is preserved rather than
 * one flat number being spread across a structure whose whole purpose is that
 * its strikes are priced differently.
 *
 * It also buys an invariant worth having: Black-Scholes at the volatility
 * implied by a price returns that price. So the "today" figure evaluated at
 * the CURRENT underlying equals the live mark-to-market shown beside it. The
 * two cannot disagree, which is the kind of disagreement nobody ever manages
 * to explain later.
 *
 * Falls back to the leg's recorded IV, then to the same default the simulator
 * uses, so a leg with no quote still produces a figure rather than a blank.
 */
export function volFor({ mid, price, strike, years, optType, storedIv }) {
  const solved = mid !== null && price !== null && years > 0
    ? impliedVol(mid, price, strike, years, RISK_FREE, optType)
    : null;
  if (solved !== null && solved > 0) return { iv: solved, from: "quote" };

  const stored = num(storedIv);
  // Stored as a percentage -- 42 means 42%.
  if (stored !== null && stored > 0) return { iv: Math.max(0.01, stored / 100), from: "recorded" };

  return { iv: DEFAULT_IV, from: "assumed" };
}

/**
 * One side: everything at a single target price.
 *
 * @param legs   shaped legs, each { contract, form, iv }
 * @param target the price being asked about
 * @param price  the live underlying, for solving each leg's volatility
 * @param midOf  (leg) => its live mid, or null
 * @param mm     the structure's market-making loss, carried through so the
 *               figure matches the Options Dashboard's own net
 */
export function sideAt({ legs, target, price, midOf, mm = 0, now = new Date() }) {
  const t = num(target);
  if (t === null || t <= 0) return null;

  let optExpiry = 0;
  let optToday = 0;
  let priced = 0;
  let assumed = 0;

  for (const l of legs || []) {
    const qty = num(l?.form?.opt_entry_qty);
    if (qty === null || qty === 0) continue;
    const entry = num(l?.form?.opt_entry_price);
    const strike = num(l?.contract?.strike);
    if (entry === null || strike === null || strike <= 0) continue;

    const optType = String(l.contract.optType || "").toUpperCase().startsWith("C") ? "CALL" : "PUT";
    const days = daysToExpiry(l.contract.expiry, now);
    const years = days === null ? 0 : days / 365;

    optExpiry += expiryPnl(t, strike, optType, entry, qty);

    if (years > 0) {
      const { iv, from } = volFor({
        mid: num(midOf(l)), price: num(price), strike, years, optType, storedIv: l.iv,
      });
      if (from === "assumed") assumed++;
      optToday += currentPnl(t, strike, years, RISK_FREE, iv, optType, entry, qty);
    } else {
      // Nothing left to model. The payoff IS the value.
      optToday += expiryPnl(t, strike, optType, entry, qty);
    }
    priced++;
  }

  if (!priced) return null;

  // The hedge at the target price. Same arithmetic as the live figure, with
  // the target standing in for the current price -- a short hedge loses on
  // the way up, which is exactly what makes the upside scenario interesting.
  const fut = futuresPnl(legs, t);
  const hedge = fut?.pnl || 0;
  const loss = num(mm) || 0;

  return {
    target: exact(t),
    optExpiry: exact(optExpiry),
    optToday: exact(optToday),
    fut: fut ? exact(hedge) : null,
    mm: exact(loss),
    expiry: exact(optExpiry + hedge + loss),
    today: exact(optToday + hedge + loss),
    // How many legs had to be priced on a guessed volatility, so a figure
    // resting on an assumption can say so rather than looking measured.
    assumed,
  };
}

/**
 * Both sides of a structure's band.
 *
 * @param limits { upper, lower } -- the card's own limits
 */
export function scenarios({ legs, limits, price, midOf, mm = 0, now = new Date() }) {
  const at = (target) => sideAt({ legs, target, price, midOf, mm, now });
  const upside = at(limits?.upper);
  const downside = at(limits?.lower);
  if (!upside && !downside) return null;
  return { upside, downside };
}

export { RISK_FREE, DEFAULT_IV, bsPrice };

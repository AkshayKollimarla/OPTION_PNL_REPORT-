// What a vertical spread cost to put on: the long leg's entry price less the
// short leg's, per share, on each side of the structure.
//
// A call spread bought at 1.80 against 0.70 sold is 1.10 paid; the same
// arithmetic on the put side gives what that half cost. Reading it off the
// cards meant subtracting two numbers that sit in different columns, and the
// figure is what the whole position is risking on each side.

const num = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Two penny prices subtract cleanly in decimal but not in binary: 1.8 - 0.7 is
// 1.0999999999999999.
const exact = (v) => Math.round(v * 1e6) / 1e6;

/**
 * One side of the structure.
 *
 * Returns null unless BOTH legs are present and priced — half a spread has no
 * spread price, and showing the long leg's premium alone would read as one.
 *
 * @param legs  [{ type, form: { opt_entry_price } }]
 * @param side  "CALL" or "PUT"
 */
export function spreadPrice(legs, side) {
  const find = (dir) => (legs || []).find((l) => l?.type === `${side} ${dir}`);
  const long = find("LONG");
  const short = find("SHORT");
  const longPrice = num(long?.form?.opt_entry_price);
  const shortPrice = num(short?.form?.opt_entry_price);
  if (longPrice === null || shortPrice === null) return null;
  const net = exact(longPrice - shortPrice);
  return {
    side,
    long: longPrice,
    short: shortPrice,
    net,
    // Paid or received. A long spread is normally a debit; if the short leg
    // is dearer than the long one the position was opened for a credit, and
    // saying so is more use than a bare negative number.
    kind: net > 0 ? "debit" : net < 0 ? "credit" : "flat",
  };
}

/** Both sides at once. Either may be null. */
export function spreadPrices(legs) {
  return { call: spreadPrice(legs, "CALL"), put: spreadPrice(legs, "PUT") };
}

/**
 * What a side of the structure has made since it was opened.
 *
 *   (live spread - entry spread) x quantity
 *
 * A vertical is held as one thing: long the near leg, short the far one, so
 * the position is worth (long - short) per unit either way, and the change in
 * that is the profit. The sign falls out of the subtraction -- a spread put on
 * for a credit is a negative net, and it making money means that net becoming
 * less negative -- so nothing here needs to know which way round it was done.
 *
 * @param legs   [{ type, form: { opt_entry_price, opt_entry_qty } }]
 * @param side   "CALL" or "PUT"
 * @param midOf  (leg) => the live mid for that leg, or null
 * @returns { side, entry, live, qty, pnl } or null when anything is missing
 */
export function sidePnl(legs, side, midOf) {
  const entry = spreadPrice(legs, side);
  if (!entry) return null;

  const find = (dir) => (legs || []).find((l) => l?.type === `${side} ${dir}`);
  const long = find("LONG");
  const short = find("SHORT");
  const longMid = num(midOf(long));
  const shortMid = num(midOf(short));
  if (longMid === null || shortMid === null) return null;

  const longQty = Math.abs(num(long?.form?.opt_entry_qty) ?? NaN);
  const shortQty = Math.abs(num(short?.form?.opt_entry_qty) ?? NaN);
  if (!Number.isFinite(longQty) || !Number.isFinite(shortQty)) return null;
  // The spread is only as big as its smaller leg. A 400/200 pair is a 200
  // spread with 200 naked calls beside it, and pricing all 400 as a spread
  // would report a profit the position cannot make.
  const qty = Math.min(longQty, shortQty);
  if (!(qty > 0)) return null;

  const live = exact(longMid - shortMid);
  return { side, entry: entry.net, live, qty, pnl: exact((live - entry.net) * qty) };
}

/** Both sides, and their sum. Either side may be null. */
export function livePnl(legs, midOf) {
  const call = sidePnl(legs, "CALL", midOf);
  const put = sidePnl(legs, "PUT", midOf);
  // Null rather than zero when neither side can be priced: zero is a result,
  // and "no live quote yet" is not one.
  const net = call || put ? exact((call?.pnl || 0) + (put?.pnl || 0)) : null;
  return { call, put, net };
}

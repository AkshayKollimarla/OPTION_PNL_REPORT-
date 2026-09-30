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

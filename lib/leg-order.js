// Reordering the legs of a structure, and starting them again on a new coin.
//
// Both of these look like presentation and are not. The simulator pairs a leg
// with its saved database row BY POSITION -- editIds[i] is the row behind
// legs[i], and the update loop writes legs[i]'s strike, premium and quantity
// to that id. So moving a leg up the screen without moving its id with it
// does not shuffle a display: it writes one leg's values into another leg's
// row, and the structure that comes back is not the one that was saved.
//
// That is why the swap lives here with a test around it rather than inline in
// a click handler.

/**
 * Two positions exchanged, as a new array.
 *
 * Pads rather than swapping a hole in from beyond the end. A leg added after
 * a strategy was loaded has no saved row, so the id list is legitimately
 * shorter than the leg list -- and `arr[j]` on a short array is `undefined`,
 * which assigned back would quietly drop the array's length and shift every
 * id after it onto the wrong leg.
 */
export function swapAt(arr, i, j) {
  if (!Array.isArray(arr) || !arr.length) return arr;
  if (i === j) return arr;
  const max = Math.max(i, j);
  const min = Math.min(i, j);
  if (min < 0) return arr;
  const next = arr.slice();
  while (next.length <= max) next.push(undefined);
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Can this leg move that way at all?
 */
export function canMove(length, idx, dir) {
  const to = idx + dir;
  return Number.isInteger(idx) && idx >= 0 && idx < length && to >= 0 && to < length;
}

// What survives a change of coin. All of it describes the structure rather
// than the market it is in: the day it is being entered, the money behind it,
// and whether it is still open.
export const COIN_INDEPENDENT = ["entry_date", "investment", "status", "end_date"];

// ...and what cannot, because every one is a price, a date or a size quoted
// in the old underlying. An explicit list rather than "clear everything
// except", so that a field added later defaults to being WIPED on a coin
// change: carrying a stale number into a different market is the failure that
// matters, and a field wrongly cleared is visibly blank rather than
// invisibly wrong.
export const COIN_SPECIFIC = [
  "options_strike", "expiry",
  "opt_entry_qty", "opt_entry_price", "opt_exit_price", "iv", "opt_mid_price_raw",
  "fut_qty", "fut_entry_price", "fut_exit_price", "fut_mid_price",
  "upside_distance", "down_distance", "basket_distance", "basket_loss",
];

/**
 * The fields worth keeping when the structure moves to another coin.
 *
 * Blanks are not carried: an empty value on the old first card should not
 * overwrite whatever a fresh leg starts with -- the entry date in particular,
 * which a new leg fills in with today.
 */
export function carriedOver(form) {
  const keep = {};
  for (const k of COIN_INDEPENDENT) {
    const v = form?.[k];
    if (v !== undefined && v !== null && v !== "") keep[k] = v;
  }
  return keep;
}

/**
 * One leg's form, emptied of everything that belonged to the old coin.
 *
 * Used for a SAVED strategy, whose legs are emptied where they stand because
 * their rows are paired to them by position. What the structure has actually
 * booked -- net_booked_pnl, market_making_pl, the exit figures -- is left
 * alone: those are history, not a position, and clearing them on a dropdown
 * change would be writing off a record of real money.
 */
export function clearedForCoin(form, coin, empty = {}) {
  const next = { ...form, ...carriedOver(form), token: coin };
  for (const k of COIN_SPECIFIC) next[k] = empty[k] ?? "";
  return next;
}

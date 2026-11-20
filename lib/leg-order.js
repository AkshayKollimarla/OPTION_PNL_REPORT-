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
 * One item lifted out and dropped back in at another position.
 *
 * Not a swap. Dragging leg 4 to the top should leave 1, 2 and 3 in the order
 * they were in, each shifted down one -- exchanging 1 and 4 would put leg 1
 * at the bottom, which is not what anyone dragging a row means.
 *
 * A destination past either end clamps, so a drop into the gap below the last
 * row lands on the last row rather than being thrown away.
 */
export function moveWithin(arr, from, to) {
  if (!Array.isArray(arr)) return arr;
  const n = arr.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return arr;
  if (from < 0 || from >= n || n < 2) return arr;
  const dest = Math.max(0, Math.min(n - 1, to));
  if (dest === from) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(dest, 0, item);
  return next;
}

/**
 * Calls first, puts after.
 *
 * The structure this book trades is a call spread over a put spread, and it
 * is read in that order. A chain click lands on whichever card of its type is
 * free and otherwise makes a new one, so picking a put before a call used to
 * leave the put standing above it for good.
 *
 * Only the CALL/PUT split is imposed. Within a side the order is whatever it
 * was built in, because long-before-short is a habit rather than a rule, and
 * a leg deliberately dragged somewhere must not be shoved back.
 */
export const typeRank = (type) =>
  (String(type || "").toUpperCase().startsWith("CALL") ? 0 : 1);

/**
 * Where a new leg of this type belongs: after the last leg of its own side,
 * or ahead of the first side that outranks it.
 */
export function insertIndexFor(legs, type) {
  const rank = typeRank(type);
  const list = Array.isArray(legs) ? legs : [];
  for (let i = 0; i < list.length; i++) {
    if (typeRank(list[i]?.type) > rank) return i;
  }
  return list.length;
}

/** The list with `leg` placed at that position. */
export function insertByType(legs, leg) {
  const list = Array.isArray(legs) ? legs : [];
  const at = insertIndexFor(list, leg?.type);
  return [...list.slice(0, at), leg, ...list.slice(at)];
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

// Upside and down distance for a combined strategy.
//
// They are not free-standing numbers: they are the gap between the futures
// entry price and the strike each short leg is sold at. At futures 2700, a
// call short at 2850 is 150 up; a put short at 2550 is 150 down. Typing them
// by hand meant keeping three fields in agreement, and a rolled strike left a
// stale distance behind that every breakeven and scenario figure then used.
//
// A value typed by hand wins over the formula, until the field is cleared,
// which hands it back.

export const DISTANCE_KEYS = ["upside_distance", "down_distance"];

// One decimal is as fine as these are read, and it keeps binary floating point
// out of the field: 2849.9 - 2700 is 149.89999999999998 before rounding.
export const round1 = (v) => Math.round(v * 10) / 10;

const num = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * What the distances should become.
 *
 * @param futEntryPrice the structure's futures entry price
 * @param callShortStrike strike of the CALL SHORT leg, or null when there is none
 * @param putShortStrike  strike of the PUT SHORT leg, or null
 * @param shown   what each field currently holds, as the form has it
 * @param manual  which fields a person has typed into
 * @param seen    which fields have already been judged once
 *
 * Returns the writes to apply, plus the updated manual/seen verdicts. A field
 * is left alone when it is manual, when there is no short leg to measure
 * against, or when it already holds the computed value — that last one is what
 * stops a write from provoking another write.
 */
export function distanceDecision({ futEntryPrice, callShortStrike, putShortStrike, shown = {}, manual = {}, seen = {} }) {
  const nextManual = { ...manual };
  const nextSeen   = { ...seen };
  const writes     = {};

  const fut = num(futEntryPrice);
  if (fut === null || fut <= 0) return { writes, manual: nextManual, seen: nextSeen };

  const call = num(callShortStrike);
  const put  = num(putShortStrike);
  const computed = {
    upside_distance: call !== null && call > 0 ? round1(call - fut) : null,
    down_distance:   put  !== null && put  > 0 ? round1(fut - put)  : null,
  };

  for (const key of DISTANCE_KEYS) {
    const value = computed[key];
    if (value === null) continue;
    const current = num(shown[key]);

    if (!nextSeen[key]) {
      nextSeen[key] = true;
      // A saved strategy arrives with distances already in it. One that does
      // not match the formula was put there on purpose, and overwriting it on
      // open would silently rewrite saved data.
      if (current !== null && round1(current) !== value) nextManual[key] = true;
    }
    if (nextManual[key]) continue;
    if (current !== null && round1(current) === value) continue;
    writes[key] = String(value);
  }
  return { writes, manual: nextManual, seen: nextSeen };
}

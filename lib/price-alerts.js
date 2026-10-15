// Price alerts for open options strategies.
//
// An open structure is protected between its two short strikes: above the
// short call and below the short put the hedge stops working. Those two
// prices are the limits worth watching, and the alert is meant to arrive
// BEFORE one is reached, by a distance the user sets -- a dollar by default.
//
// Everything here is pure. The feed, the database and Telegram live
// elsewhere, so the rules that decide whether to wake someone up can be
// tested without any of them.

export const DEFAULT_OFFSET = 1;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A strike may be stored as "1675 CALL" or "62000 CE", the style it was
// entered in, so the number is read out of it rather than cast.
const strikeNum = (v) => {
  const m = /\d+(?:\.\d+)?/.exec(String(v ?? "").replace(/,/g, ""));
  return m ? Number(m[0]) : null;
};

/**
 * The band an open strategy is protected inside.
 *
 * The short strikes are exact; the distances are rounded to one decimal when
 * they are stored, so they are only a fallback for a structure that has no
 * short leg on that side.
 *
 * @param legs [{ option_type, opt_entry_qty, options_strike, fut_entry_price,
 *                upside_distance, down_distance }]
 */
export function deriveLimits(legs) {
  const rows = legs || [];
  const shortStrike = (type) => {
    for (const l of rows) {
      if (String(l.option_type || "").toUpperCase() !== type) continue;
      if (!(num(l.opt_entry_qty) < 0)) continue;
      const k = strikeNum(l.options_strike);
      if (k !== null && k > 0) return k;
    }
    return null;
  };

  const fut = rows.map((l) => num(l.fut_entry_price)).find((v) => v !== null && v > 0) ?? null;
  const up = rows.map((l) => num(l.upside_distance)).find((v) => v !== null) ?? null;
  const down = rows.map((l) => num(l.down_distance)).find((v) => v !== null) ?? null;

  // Rounded: 293.36 + 21.6 is 314.96000000000004 in binary, and that lands in
  // an alert message and a comparison against a typed threshold.
  const exact = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  const upper = shortStrike("CALL") ?? exact(fut !== null && up !== null ? fut + up : null);
  const lower = shortStrike("PUT") ?? exact(fut !== null && down !== null ? fut - down : null);

  return {
    upper,
    lower,
    futPrice: fut,
    // Which side came from a strike, so the page can say what it is watching.
    upperFrom: shortStrike("CALL") !== null ? "short call" : upper !== null ? "distance" : null,
    lowerFrom: shortStrike("PUT") !== null ? "short put" : lower !== null ? "distance" : null,
  };
}

/**
 * Where the alerts actually sit.
 *
 * By default a dollar inside each limit -- below the upper, above the lower --
 * so the warning arrives while there is still room to act. A value typed by
 * hand replaces the computed one outright and is used as given.
 */
export function triggersFor({ upper, lower }, { offset = DEFAULT_OFFSET, alertUpper = null, alertLower = null } = {}) {
  const off = num(offset) ?? DEFAULT_OFFSET;
  const manualUpper = num(alertUpper);
  const manualLower = num(alertLower);
  return {
    upper: manualUpper !== null ? manualUpper : (upper !== null ? upper - off : null),
    lower: manualLower !== null ? manualLower : (lower !== null ? lower + off : null),
    upperManual: manualUpper !== null,
    lowerManual: manualLower !== null,
    offset: off,
  };
}

/**
 * Is this price plausibly the same instrument as these limits?
 *
 * A feed can hand back a price for a different market of the same name --
 * PURR quotes at $0.10 against a grid written for 10.50-14.50 -- and a price
 * nowhere near the band would otherwise sit permanently below the lower
 * trigger and alert forever. One band-width of slack either side is generous
 * for a real move and still catches a mismatch of that size.
 */
export function priceLooksRelated(price, { upper, lower }) {
  const p = num(price);
  if (p === null) return false;
  const u = num(upper), l = num(lower);
  if (u === null && l === null) return false;

  if (u !== null && l !== null) {
    const width = Math.abs(u - l) || Math.abs(u) * 0.1;
    return p >= l - width && p <= u + width;
  }

  // A manually set alert may name only one side, so there is no band to
  // measure against. A third to three times the level is wide enough for any
  // real move and still rejects a feed quoting a different market entirely --
  // PURR at $0.10 against a level of 12.50.
  const one = u !== null ? u : l;
  if (one === 0) return true;
  const ratio = p / Math.abs(one);
  return ratio >= 1 / 3 && ratio <= 3;
}

/**
 * How far the price must retreat before the same alert can fire again.
 *
 * Re-arming the moment the price steps one tick back out of the zone looked
 * right and was not: a coin resting on its trigger crosses it both ways every
 * few seconds, and each crossing sent a message. The price has to come back a
 * real distance -- the alert distance itself, or two tenths of a percent,
 * whichever is larger -- before the level counts as un-breached.
 */
export const REARM_FRACTION = 0.002;

/**
 * And a quiet period, so a level that is being hugged cannot be reported
 * every few minutes even when the price does retreat properly between times.
 */
export const COOLDOWN_MS = 15 * 60 * 1000;

function rearmGap(level, offset) {
  const o = Math.abs(num(offset) ?? 0);
  return Math.max(o, Math.abs(level) * REARM_FRACTION);
}

const sideState = (s) => ({
  approachArmed: s?.approachArmed !== false,
  crossArmed: s?.crossArmed !== false,
  firedAt: Number(s?.firedAt) || 0,
});

/**
 * What to send, and what to remember.
 *
 * Each side has two levels and reports each once:
 *
 *   approach  the alert level, a set distance inside the limit -- the warning
 *             while there is still room to act.
 *   cross     the limit itself. Asked for separately because a price can go
 *             straight through: the approach may be reported and then nothing
 *             more, which reads as the alert having stopped working.
 *
 * Each is armed on its own, so a fast move that clears both sends both, and a
 * slow drift sends the approach now and the cross whenever it arrives.
 *
 * @param state { upper: {approachArmed, crossArmed, firedAt}, lower: {...} }
 * @param now   epoch ms, injected so the cooldown is testable
 */
export function evaluate({ price, triggers, limits, state = {}, now = Date.now(), cooldownMs = COOLDOWN_MS }) {
  const p = num(price);
  const upper = sideState(state.upper);
  const lower = sideState(state.lower);
  const out = { fire: [], state: { upper, lower, lastPrice: p }, skipped: null };

  if (p === null) { out.skipped = "no price"; return out; }
  if (!priceLooksRelated(p, limits)) { out.skipped = "price far outside the band"; return out; }

  const offset = triggers.offset;

  // The upper side: the price rising into, then through, its levels.
  const up = [
    { kind: "approach", level: num(triggers.upper), armed: "approachArmed" },
    { kind: "cross", level: num(limits.upper), armed: "crossArmed" },
  ];
  for (const { kind, level, armed } of up) {
    if (level === null) continue;
    const breached = p >= level;
    if (breached && upper[armed] && now - upper.firedAt >= 0) {
      out.fire.push({ side: "upper", kind, level });
      upper[armed] = false;
      upper.firedAt = now;
    } else if (!breached && p <= level - rearmGap(level, offset) && now - upper.firedAt >= cooldownMs) {
      upper[armed] = true;
    }
  }

  // ...and the lower side, falling.
  const down = [
    { kind: "approach", level: num(triggers.lower), armed: "approachArmed" },
    { kind: "cross", level: num(limits.lower), armed: "crossArmed" },
  ];
  for (const { kind, level, armed } of down) {
    if (level === null) continue;
    const breached = p <= level;
    if (breached && lower[armed]) {
      out.fire.push({ side: "lower", kind, level });
      lower[armed] = false;
      lower.firedAt = now;
    } else if (!breached && p >= level + rearmGap(level, offset) && now - lower.firedAt >= cooldownMs) {
      lower[armed] = true;
    }
  }

  return out;
}

/** The message a fired alert sends. */
export function alertMessage({ token, account, side, kind = "approach", price, trigger, limit, expiry }) {
  const arrow = side === "upper" ? "↑" : "↓";
  const word = side === "upper" ? "upper" : "lower";
  const headline = kind === "cross"
    ? `${arrow} <b>${token}</b> has <b>crossed</b> its ${word} limit`
    : `${arrow} <b>${token}</b> is approaching its ${word} limit`;
  const money = (v) => (v === null || v === undefined ? "?" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
  return [
    headline,
    ``,
    `Price:   <b>${money(price)}</b>`,
    `Alert:   ${money(trigger)}`,
    `Limit:   ${money(limit)}  (short ${side === "upper" ? "call" : "put"})`,
    account ? `Account: ${account}` : null,
    expiry ? `Expiry:  ${expiry}` : null,
  ].filter((l) => l !== null).join("\n");
}

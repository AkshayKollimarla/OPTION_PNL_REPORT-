// What an open structure is worth right now: the options, the hedge, and the
// two together.
//
// Built here rather than in the page because the option quotes need a venue
// credential and the browser has none. The arithmetic itself lives in
// lib/spread-price.js, shared with the simulator, so a figure on a price
// alert card and a figure on the simulator are the same calculation and
// cannot drift into disagreeing about the same position.
//
// Everything fails soft and one structure at a time. A venue that refuses, a
// contract that has no two-sided quote, an account with no credentials on it
// -- each costs that card its figures and nothing else. The page this feeds
// exists to show a price next to a limit, and it must still do that when the
// option book cannot be reached.

import { legMidsFor } from "./live-legs.js";
import { legKey } from "./leg-key.js";
import { positionPnl, futuresPnl } from "./spread-price.js";
import { scenarios } from "./scenario-pnl.js";
import { strikeNumber } from "./options-calculations.js";

// Structures priced at a time. The page refreshes every twenty seconds and
// Deribit wants one request per contract, so a book of a dozen four-legged
// structures is fifty-odd requests -- fine in four lanes, a burst all at
// once, and a burst is what gets an address rate-limited.
const LANES = 4;

const contractOf = (l) => ({
  token: l.token,
  expiry: l.expiry,
  strike: strikeNumber(l.options_strike),
  optType: String(l.option_type || "").toUpperCase().startsWith("P") ? "PUT" : "CALL",
});

// The shape lib/spread-price.js reads, which is the simulator's leg shape,
// plus what the scenarios need on top of it.
const shape = (l) => ({
  contract: contractOf(l),
  form: {
    opt_entry_qty: l.opt_entry_qty,
    opt_entry_price: l.opt_entry_price,
    fut_qty: l.fut_qty,
    fut_entry_price: l.fut_entry_price,
  },
  // The leg's recorded volatility, used only when its live quote cannot be
  // solved for one.
  iv: l.iv ?? null,
});

const priceable = (l) =>
  l && l.token && l.expiry && strikeNumber(l.options_strike) > 0 && l.option_type;

/**
 * Live option mids for several structures at once.
 *
 * @param groups Map<key, legs[]> as the watch list groups them
 * @returns Map<key, { venue, mids, error }>
 */
export async function fetchGroupMids(groups) {
  const out = new Map();
  const jobs = [...groups.entries()];

  for (let i = 0; i < jobs.length; i += LANES) {
    await Promise.all(jobs.slice(i, i + LANES).map(async ([key, group]) => {
      const first = group[0] || {};
      const legs = group.filter(priceable).map(contractOf);
      if (!legs.length) return;
      // No credential, no quote. Thirty of this book's structures predate
      // accounts being recorded at all; they still get a hedge figure below,
      // which needs no venue.
      if (!first.api_key) { out.set(key, { venue: null, mids: {}, error: "no venue credentials on this account" }); return; }
      try {
        out.set(key, await legMidsFor(first, legs));
      } catch (err) {
        out.set(key, { venue: null, mids: {}, error: err.message });
      }
    }));
  }
  return out;
}

/**
 * The three figures for one structure.
 *
 * @param group  its legs, as the watch list query returns them
 * @param quotes its entry from fetchGroupMids, or undefined
 * @param price  the live underlying price the card already fetched
 *
 * `net` is only reported once EVERY option leg has been priced. A net made
 * from three legs of four is not this position's net, and the one that failed
 * to quote is as likely as not the one that moved -- so the card says how
 * much it could see instead of adding up what it happened to get.
 */
export function pnlFor(group, quotes, price, limits = null) {
  const legs = (group || []).map(shape);
  const midOf = (l) => quotes?.mids?.[legKey(l.contract)]?.mid ?? null;

  const opt = positionPnl(legs, midOf);
  const fut = futuresPnl(legs, price);

  // What it makes if the coin reaches either limit -- at expiry, and if it
  // got there today.
  //
  // The market-making loss is carried on ONE leg per structure, never
  // repeated across them and never split: checked across the whole book, 75
  // multi-leg structures carry it on a single leg and 10 carry none. Summed
  // anyway, as the simulator does, so the two agree and so a split one would
  // report its total rather than a slice.
  const mm = (group || []).reduce((s, l) => {
    const v = Number(l.total_mm_loss);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const scene = limits ? scenarios({ legs, limits, price, midOf, mm }) : null;

  // A structure with no option legs holding anything is complete by having
  // nothing outstanding, so its hedge alone IS its net.
  const optDone = opt.complete || (opt.priced === 0 && opt.unpriced === 0);
  const net = optDone && (opt.pnl !== null || fut)
    ? Math.round(((opt.pnl || 0) + (fut?.pnl || 0)) * 1e6) / 1e6
    : null;

  return {
    opt: opt.pnl,
    fut: fut?.pnl ?? null,
    net,
    priced: opt.priced,
    unpriced: opt.unpriced,
    venue: quotes?.venue || null,
    error: quotes?.error || null,
    // Unlike the live figure above, these do not need a quote: they are
    // modelled from the entry prices and the strikes, so a venue that is
    // refusing costs the card its mark-to-market and not its scenarios. A
    // quote only sharpens them, by supplying the volatility.
    scenarios: scene,
  };
}

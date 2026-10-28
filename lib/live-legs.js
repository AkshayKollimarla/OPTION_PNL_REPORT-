// Live mids for several option legs at once.
//
// The per-leg ticker endpoint exists already, but a structure polled every
// two seconds would make four requests each time. Both venues can answer for
// several contracts in one call, so this does that instead: one request per
// poll however many legs there are.

import pool from "./options-db.js";
import { isAlpacaKey, occSymbol } from "./alpaca.js";
import { priceFor, hyperliquidMids } from "./price-feed.js";

const DATA = "https://data.alpaca.markets";
const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const OPTION_FEED = "indicative";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A mid only, and only from a two-sided quote. A last trade can be hours old,
// and half a book is not a price -- the same rule the rest of the app prices
// options by, so a figure here agrees with the one beside it.
const midOf = (bid, ask) => {
  const b = num(bid), a = num(ask);
  return b > 0 && a > 0 ? Math.round(((b + a) / 2) * 1e6) / 1e6 : null;
};

export { legKey } from "./leg-key.js";
import { legKey } from "./leg-key.js";

async function alpacaMids(legs, acct) {
  const symbols = new Map();
  for (const l of legs) {
    const sym = occSymbol(l.token, l.expiry, l.strike, l.optType);
    if (sym) symbols.set(sym, legKey(l));
  }
  if (!symbols.size) return {};

  const url = `${DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent([...symbols.keys()].join(","))}&feed=${OPTION_FEED}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": acct.api_key,
      "APCA-API-SECRET-KEY": acct.api_secret,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();

  const out = {};
  for (const [sym, key] of symbols) {
    const q = body?.snapshots?.[sym]?.latestQuote;
    out[key] = { mid: midOf(q?.bp, q?.ap), bid: num(q?.bp), ask: num(q?.ap), instrument: sym };
  }
  return out;
}

const deribitName = ({ token, expiry, strike, optType }) => {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (isNaN(d)) return null;
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const label = `${d.getUTCDate()}${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;
  return `${String(token).toUpperCase()}-${label}-${Number(strike)}-${String(optType).toUpperCase().startsWith("C") ? "C" : "P"}`;
};

async function deribitMids(legs, acct) {
  const base = acct?.testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  // Public tickers, one per contract but all in flight together, and no
  // authentication -- so this cannot contend with the auto-close worker for
  // the single token Deribit allows per key.
  const results = await Promise.allSettled(legs.map(async (l) => {
    const name = deribitName(l);
    if (!name) return null;
    const res = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(name)}`, { cache: "no-store" });
    const body = await res.json();
    const r = body?.result;
    return {
      key: legKey(l),
      value: { mid: midOf(r?.best_bid_price, r?.best_ask_price), bid: num(r?.best_bid_price), ask: num(r?.best_ask_price), instrument: name },
    };
  }));

  const out = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out[r.value.key] = r.value.value;
  }
  return out;
}

/**
 * @param accountId whose credentials to price with
 * @param legs [{ token, expiry, strike, optType }]
 * @returns { [legKey]: { mid, bid, ask, instrument } }
 */
export async function fetchLegMids(accountId, legs) {
  const wanted = (legs || []).filter((l) => l && l.token && l.expiry && Number(l.strike) > 0 && l.optType);
  if (!wanted.length) return { mids: {}, venue: null };

  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`, [accountId]);
  if (!rows.length) throw new Error("No such account.");
  const acct = rows[0];

  const venue = isAlpacaKey(acct.api_key) ? "alpaca" : "deribit";
  const mids = venue === "alpaca" ? await alpacaMids(wanted, acct) : await deribitMids(wanted, acct);
  return { mids, venue };
}

/**
 * The legs AND the underlying, in one round trip.
 *
 * The hedge is priced beside the options because the page needs both every
 * two seconds, and asking separately would double the requests to show one
 * number. The underlying goes through the same resolver the rest of the app
 * uses -- HIP-3 first, then Alpaca, then Deribit for a perpetual.
 */
export async function fetchStrategyQuotes(accountId, legs, futToken) {
  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`, [accountId]);
  if (!rows.length) throw new Error("No such account.");
  const acct = rows[0];
  const venue = isAlpacaKey(acct.api_key) ? "alpaca" : "deribit";

  const wanted = (legs || []).filter((l) => l && l.token && l.expiry && Number(l.strike) > 0 && l.optType);
  const credential = { api_key: acct.api_key, api_secret: acct.api_secret };

  const [legResult, futResult] = await Promise.allSettled([
    wanted.length
      ? (venue === "alpaca" ? alpacaMids(wanted, acct) : deribitMids(wanted, acct))
      : Promise.resolve({}),
    futToken
      ? hyperliquidMids().then((mids) => priceFor({ token: futToken, credential, mids }))
      : Promise.resolve(null),
  ]);

  return {
    venue,
    mids: legResult.status === "fulfilled" ? legResult.value : {},
    legError: legResult.status === "rejected" ? (legResult.reason?.message || String(legResult.reason)) : null,
    // The hedge failing must not blank the option figures, and the reverse.
    fut: futResult.status === "fulfilled" ? futResult.value : null,
    futError: futResult.status === "rejected" ? (futResult.reason?.message || String(futResult.reason)) : null,
  };
}

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

// A Deribit instrument quoted in its own quote currency rather than in the
// coin. SOL_USDC-18NOV26-100-C is priced in dollars; BTC-18NOV26-80000-C is
// priced in BTC.
const isLinear = (name) => /_USDC|_USDT/i.test(String(name || ""));

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

    // An inverse option is quoted IN THE COIN: an ETH call at 0.231 is 0.231
    // ETH, about $420. The book stores option prices in dollars -- an ETH put
    // went on at 79.14, not at 0.032 -- so handing the raw figure back makes
    // (mid - entry) a subtraction of two different units, and every P&L drawn
    // from it wrong by a factor of the coin price. Converted with the
    // ticker's own underlying price, which is how the option chain and the
    // Deribit position reader already do it.
    //
    // No underlying price means no conversion and therefore no quote: null is
    // "not priced", which the caller shows as such. A coin figure passed off
    // as dollars is the one answer that must not get out.
    const u = num(r?.underlying_price);
    const toUsd = isLinear(name)
      ? (v) => v
      : (v) => (v === null || u === null ? null : Math.round(v * u * 1e6) / 1e6);
    const bid = toUsd(num(r?.best_bid_price));
    const ask = toUsd(num(r?.best_ask_price));

    return {
      key: legKey(l),
      value: { mid: midOf(bid, ask), bid, ask, instrument: name, underlying: u },
    };
  }));

  const out = {};
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out[r.value.key] = r.value.value;
  }
  return out;
}

/**
 * Mids for a set of legs, priced with a credential already in hand.
 *
 * The venue is decided by the credential, never by the account's exchange
 * column -- the US equity account is labelled "hyperliquid" so its strategies
 * group with the bot entries they hedge against.
 *
 * Exported because the price-alerts page builds its cards from a query that
 * has already joined the account in. Going back to the database once per
 * structure, to re-read two columns it is holding, would be a round trip per
 * card on a page that refreshes itself every twenty seconds.
 *
 * @param acct { api_key, api_secret, testnet }
 * @param legs [{ token, expiry, strike, optType }]
 * @returns { venue, mids: { [legKey]: { mid, bid, ask, instrument } } }
 */
export async function legMidsFor(acct, legs) {
  const venue = isAlpacaKey(acct?.api_key) ? "alpaca" : "deribit";
  const wanted = (legs || []).filter((l) => l && l.token && l.expiry && Number(l.strike) > 0 && l.optType);
  if (!wanted.length) return { venue, mids: {} };
  return { venue, mids: venue === "alpaca" ? await alpacaMids(wanted, acct) : await deribitMids(wanted, acct) };
}

async function accountById(accountId) {
  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`, [accountId]);
  if (!rows.length) throw new Error("No such account.");
  return rows[0];
}

/**
 * @param accountId whose credentials to price with
 * @param legs [{ token, expiry, strike, optType }]
 * @returns { [legKey]: { mid, bid, ask, instrument } }
 */
export async function fetchLegMids(accountId, legs) {
  const wanted = (legs || []).filter((l) => l && l.token && l.expiry && Number(l.strike) > 0 && l.optType);
  if (!wanted.length) return { mids: {}, venue: null };
  return legMidsFor(await accountById(accountId), wanted);
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
  const acct = await accountById(accountId);
  const venue = isAlpacaKey(acct.api_key) ? "alpaca" : "deribit";
  const credential = { api_key: acct.api_key, api_secret: acct.api_secret };

  const [legResult, futResult] = await Promise.allSettled([
    legMidsFor(acct, legs).then((q) => q.mids),
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

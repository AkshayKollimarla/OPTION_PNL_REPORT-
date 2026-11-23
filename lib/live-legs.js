// Live mids for several option legs at once.
//
// The per-leg ticker endpoint exists already, but a structure polled every
// two seconds would make four requests each time. Both venues can answer for
// several contracts in one call, so this does that instead: one request per
// poll however many legs there are.

import pool from "./options-db.js";
import { isAlpacaKey, occSymbol } from "./alpaca.js";
import { priceFor, hyperliquidMids } from "./price-feed.js";
import * as binance from "./binance.js";

const DATA = "https://data.alpaca.markets";
const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const OPTION_FEED = "indicative";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// How long a fetched quote is reused.
//
// This is what lets the pages poll as fast as they like without the venues
// seeing that rate. The price alerts page asks every second; two tabs open,
// plus the simulator, plus a phone, would otherwise be four times the
// requests for the same four contracts, and a public endpoint answers that
// with a 429 rather than with prices.
//
// Just under the fastest poll, so a caller asking every second gets a fresh
// answer every second and never a repeat of the one it just had.
const QUOTE_TTL_MS = 900;

// Survives hot reload in development, which would otherwise drop the cache --
// and the in-flight map with it -- on every edit.
const _q = globalThis.__legQuoteCache || (globalThis.__legQuoteCache = {
  cache: new Map(), inFlight: new Map(),
});

/**
 * A fetch whose result is shared, both across time and across callers.
 *
 * The in-flight half matters as much as the cached half: without it, ten
 * simultaneous pollers all miss the cache in the same millisecond and all
 * ten go to the venue. With it, the first goes and the other nine wait on
 * that same promise.
 *
 * A failure after a success serves the last good answer rather than nothing.
 * A quote 900ms stale beats a blank card, and the figures built on it carry
 * their own sanity checks.
 */
async function quoted(key, load) {
  const hit = _q.cache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.value;

  let pending = _q.inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const value = await load();
      _q.cache.set(key, { at: Date.now(), value });
      return value;
    })().finally(() => _q.inFlight.delete(key));
    _q.inFlight.set(key, pending);
  }

  try {
    return await pending;
  } catch (err) {
    if (hit) return hit.value;
    throw err;
  }
}

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

  // Sorted so two callers asking for the same contracts in a different order
  // share one cache entry rather than each keeping their own.
  const list = [...symbols.keys()].sort().join(",");
  const url = `${DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent(list)}&feed=${OPTION_FEED}`;

  const body = await quoted(`alpaca:${acct.api_key}:${list}`, async () => {
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": acct.api_key,
        "APCA-API-SECRET-KEY": acct.api_secret,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  });

  const out = {};
  for (const [sym, key] of symbols) {
    const q = body?.snapshots?.[sym]?.latestQuote;
    out[key] = { mid: midOf(q?.bp, q?.ap), bid: num(q?.bp), ask: num(q?.ap), instrument: sym };
  }
  return out;
}

const venueOf = (acct) => {
  if (isAlpacaKey(acct?.api_key)) return "alpaca";
  if (String(acct?.exchange || "").toLowerCase() === "binance") return "binance";
  return "deribit";
};

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
    // One ticker per contract rather than the whole currency's book summary.
    // It looks like more requests and is far less data: ETH alone lists 788
    // options and the USDC book 3,234, which is most of a megabyte a second
    // to read four strikes out of. Keyed on the contract, so every caller
    // wanting that contract shares the one request.
    const r = await quoted(`deribit:${base}:${name}`, async () => {
      const res = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(name)}`, { cache: "no-store" });
      const body = await res.json();
      return body?.result;
    });

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
  const venue = venueOf(acct);
  const wanted = (legs || []).filter((l) => l && l.token && l.expiry && Number(l.strike) > 0 && l.optType);
  if (!wanted.length) return { venue, mids: {} };
  if (venue === "alpaca")  return { venue, mids: await alpacaMids(wanted, acct) };
  // Binance keys its mids by its own instrument name, which is not the
  // legKey the rest of the app looks them up by.
  if (venue === "binance") return { venue, mids: await binanceMids(wanted) };
  return { venue, mids: await deribitMids(wanted, acct) };
}

/**
 * Binance mids, re-keyed.
 *
 * The client returns one entry per Binance instrument name; every caller
 * here looks a leg up by legKey. Translated at the boundary rather than
 * teaching legKey about a fourth naming scheme.
 */
async function binanceMids(legs) {
  const byName = await binance.legMids(legs);
  const out = {};
  for (const l of legs) {
    const name = binance.buildInstrument(l.token, l.expiry, l.strike, l.optType);
    const q = name ? byName[name] : null;
    if (q) out[legKey(l)] = { mid: q.mid, bid: q.bid, ask: q.ask, instrument: name };
  }
  return out;
}

async function accountById(accountId) {
  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet, exchange FROM trading_accounts WHERE id = ?`, [accountId]);
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
  const venue = venueOf(acct);
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

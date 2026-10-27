// A live price for a coin, whichever venue quotes it.
//
// The book runs three kinds of market under one roof and each has its own
// source, so a single feed cannot serve them:
//
//   Hyperliquid  HYPE, PURR and the rest of its perps. One public call
//                returns every mid at once, so the whole page costs one
//                request however many coins are on it.
//   Alpaca       the US equities the options book hedges -- HOOD, PLTR,
//                NBIS. Needs the account's own keys, and is already
//                implemented for the entry pages.
//   Deribit      the BTC/ETH/SOL perpetuals. Public ticker, no auth.
//
// Which one answers is decided by asking, not by a hard-coded list: a coin
// Hyperliquid quotes is taken from there, and anything else falls through to
// the venue that can price it. A new listing then works without a code
// change.

import { fetchUnderlying as alpacaUnderlying, isAlpacaKey } from "./alpaca.js";

const HL_INFO = "https://api.hyperliquid.xyz/info";
const DERIBIT = "https://www.deribit.com/api/v2/public";

// Every Hyperliquid mid in one call. Cached briefly: the alerts worker and
// the page both ask, and the figures only move so fast.
const MIDS_TTL_MS = 5_000;
let midsCache = { at: 0, mids: null };

export async function hyperliquidMids({ now = Date.now() } = {}) {
  if (midsCache.mids && now - midsCache.at < MIDS_TTL_MS) return midsCache.mids;
  try {
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const mids = {};
    for (const [coin, px] of Object.entries(json || {})) {
      const n = Number(px);
      if (Number.isFinite(n) && n > 0) mids[coin.toUpperCase()] = n;
    }
    midsCache = { at: now, mids };
    return mids;
  } catch {
    // A stale map beats none: a missed poll should not blank every price on
    // the page, and the alert logic has its own sanity checks.
    return midsCache.mids || {};
  }
}

// Hyperliquid's HIP-3 markets: perps deployed by builders rather than by the
// exchange, each under its own "dex" and named "<dex>:<SYMBOL>".
//
// The equity perps this book hedges live on the xyz dex -- BE, HOOD, NBIS,
// PLTR, CRCL, INTC, MSTR, AMD, CRWV, SPCX are all there -- and they are real
// time, where the free Alpaca stock feed is fifteen minutes behind.
//
// The dex matters and is not interchangeable: km:PLTR and xyz:PLTR quote the
// same ticker at 130 and 201, being different contracts. So this names one
// dex rather than searching them all and taking whatever answers first.
export const HIP3_DEX = "xyz";

const hip3Cache = { at: 0, mids: null };

export async function hip3Mids({ now = Date.now() } = {}) {
  if (hip3Cache.mids && now - hip3Cache.at < MIDS_TTL_MS) return hip3Cache.mids;
  try {
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids", dex: HIP3_DEX }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const mids = {};
    for (const [name, px] of Object.entries(json || {})) {
      const n = Number(px);
      if (!Number.isFinite(n) || n <= 0) continue;
      // Keyed by the bare ticker, which is what the book stores.
      const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
      mids[bare.toUpperCase()] = n;
    }
    hip3Cache.at = now;
    hip3Cache.mids = mids;
    return mids;
  } catch {
    // A stale map beats none; a missed poll should not blank a price.
    return hip3Cache.mids || {};
  }
}

/** The HIP-3 price for one ticker, or null when that dex does not list it. */
export async function hip3Price(symbol) {
  const mids = await hip3Mids();
  const v = mids[coinOf(symbol)];
  return v === undefined ? null : v;
}

export async function deribitMid(instrument) {
  try {
    const res = await fetch(`${DERIBIT}/ticker?instrument_name=${encodeURIComponent(instrument)}`, { cache: "no-store" });
    const json = await res.json();
    const r = json?.result;
    const mid = Number(r?.mark_price ?? r?.last_price);
    return Number.isFinite(mid) && mid > 0 ? mid : null;
  } catch {
    return null;
  }
}

/** The plain coin behind a stored token: SOL_USDC and BE-30SEP are SOL and BE. */
export function coinOf(token) {
  return String(token || "").split(/[-_]/)[0].trim().toUpperCase();
}

const isDeribitInstrument = (token) => /PERPETUAL$/i.test(String(token || ""));

/**
 * Price one coin.
 *
 * @param token     the stored token, e.g. "BE", "HYPE-USDC", "BTC-PERPETUAL"
 * @param credential { api_key, api_secret } of the account, for Alpaca
 * @param mids      a Hyperliquid map from hyperliquidMids(), passed in so a
 *                  page pricing ten coins makes one call rather than ten
 * @returns { price, source } -- source names the venue that answered
 */
export async function priceFor({ token, credential = null, mids = null }) {
  const coin = coinOf(token);

  if (isDeribitInstrument(token)) {
    const price = await deribitMid(token);
    return { price, source: "deribit" };
  }

  const map = mids || (await hyperliquidMids());
  if (map[coin] !== undefined) return { price: map[coin], source: "hyperliquid" };

  // Hyperliquid's HIP-3 xyz dex runs a perp on these equities and quotes it
  // continuously. Asked before Alpaca because Alpaca's free book for the same
  // name can be thin enough that its midpoint is not a price at all -- which
  // is what fired an NBIS alert at a level the stock never reached.
  const hip3 = await hip3Price(coin);
  if (hip3 > 0) return { price: hip3, source: `hyperliquid ${HIP3_DEX}` };

  if (credential && isAlpacaKey(credential.api_key)) {
    const u = await alpacaUnderlying(coin, credential.api_key, credential.api_secret).catch(() => null);
    // A quote whose sides are far apart has a meaningless midpoint, so it is
    // reported as no price rather than acted on.
    if (u && u.wide) {
      return { price: null, source: `alpaca ${u.feed}`, error: `${coin} is quoted ${u.spread_fraction}% wide on Alpaca, so its mid is not a price.` };
    }
    if (u && u.mid > 0) return { price: u.mid, source: `alpaca ${u.feed}`, delayedMinutes: u.delayed_minutes };
    // A quote with one side empty is not a price; say so rather than
    // substituting a last trade that may be hours old.
    return { price: null, source: "alpaca", error: `no two-sided quote for ${coin}` };
  }

  return { price: null, source: null, error: `no feed quotes ${coin}` };
}

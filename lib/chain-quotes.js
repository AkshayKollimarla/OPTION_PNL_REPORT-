// A whole expiry's quotes in one request.
//
// The grid polls this every couple of seconds, so the cost that matters is
// requests per poll, not bytes. Both venues can answer for an entire expiry at
// once -- Alpaca with a chain snapshot, Deribit with a book summary -- so this
// never walks strike by strike.

import pool from "./options-db.js";
import { isAlpacaKey, parseOccSymbol, fetchUnderlying } from "./alpaca.js";
import { buildChainRows, dteOf } from "./option-chain.js";
import { hip3Price } from "./price-feed.js";

const DATA = "https://data.alpaca.markets";
const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const OPTION_FEED = "indicative";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Alpaca: one snapshot call per expiry, paged.
 *
 * The strike filter is left off deliberately -- the whole expiry is wanted and
 * asking for it in one request beats a call per strike window every time the
 * user widens the view.
 */
async function alpacaExpiry(token, expiry, acct) {
  const headers = {
    "APCA-API-KEY-ID": acct.api_key,
    "APCA-API-SECRET-KEY": acct.api_secret,
    Accept: "application/json",
  };
  const contracts = [];
  let quoteAt = null;
  let pageToken = "";
  // Bounded: a runaway cursor must not loop on a page the grid polls.
  for (let page = 0; page < 6; page++) {
    const qs = new URLSearchParams({ feed: OPTION_FEED, expiration_date: expiry, limit: "1000" });
    if (pageToken) qs.set("page_token", pageToken);
    const res = await fetch(
      `${DATA}/v1beta1/options/snapshots/${encodeURIComponent(String(token).toUpperCase())}?${qs}`,
      { headers, cache: "no-store" });
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = await res.json();

    for (const [symbol, snap] of Object.entries(body?.snapshots || {})) {
      const parts = parseOccSymbol(symbol);
      if (!parts) continue;
      const q = snap?.latestQuote;
      if (q?.t && (!quoteAt || q.t > quoteAt)) quoteAt = q.t;
      contracts.push({
        strike: parts.strike,
        optType: parts.optType,
        bid: num(q?.bp),
        ask: num(q?.ap),
        // Alpaca publishes no mark of its own for options; the mid is it.
        mark: null,
        // Nor greeks or an IV on this feed, so both are solved downstream.
        iv: null,
        volume: num(snap?.dailyBar?.v),
        // Not in the snapshot payload at all. Blank rather than zero: nobody
        // should read "no open interest" off a field the venue never sent.
        oi: null,
        instrument: symbol,
      });
    }
    pageToken = body?.next_page_token || "";
    if (!pageToken) break;
  }
  return { contracts, quoteAt };
}

/**
 * Deribit: one public book summary for the currency, filtered to the expiry.
 *
 * Public on purpose. The private endpoints allow one token per API key and the
 * auto-close workers re-authenticate on their own tick, so a grid polling
 * every two seconds on the same key would be fighting them for it.
 */
async function deribitExpiry(token, expiry, acct) {
  const base = acct?.testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const coin = String(token).toUpperCase().replace(/_USDC$|_USDT$/, "");
  const res = await fetch(
    `${base}/public/get_book_summary_by_currency?currency=${encodeURIComponent(coin)}&kind=option`,
    { cache: "no-store" });
  if (!res.ok) throw new Error(`Deribit ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`Deribit: ${body.error.message}`);

  const contracts = [];
  let underlying = null;
  for (const r of body.result || []) {
    const parts = parseDeribitName(r.instrument_name);
    if (!parts || parts.expiry !== expiry) continue;
    // Inverse options are quoted in coin. Everything the grid shows is in the
    // quote currency of the underlying, so they are converted here and the
    // row builder never has to know which venue it is looking at.
    const u = num(r.underlying_price);
    const toUsd = (v) => (v === null || u === null ? null : v * u);
    const linear = /_USDC|_USDT/.test(r.instrument_name);
    const conv = linear ? ((v) => v) : toUsd;
    if (u !== null) underlying = u;

    contracts.push({
      strike: parts.strike,
      optType: parts.optType,
      bid: conv(num(r.bid_price)),
      ask: conv(num(r.ask_price)),
      mark: conv(num(r.mark_price)),
      iv: num(r.mark_iv),
      volume: num(r.volume),
      oi: num(r.open_interest),
      instrument: r.instrument_name,
    });
  }
  return { contracts, underlying };
}

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ETH-4NOV26-2360-C -> { expiry: "2026-11-04", strike: 2360, optType: "CALL" }
export function parseDeribitName(name) {
  const m = /^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/.exec(String(name || "").toUpperCase());
  if (!m) return null;
  const month = MON.indexOf(m[3]);
  if (month < 0) return null;
  const p = (v) => String(v).padStart(2, "0");
  return {
    expiry: `20${m[4]}-${p(month + 1)}-${p(m[2])}`,
    strike: Number(m[5]),
    optType: m[6] === "C" ? "CALL" : "PUT",
  };
}

/**
 * @returns { venue, underlying, expiry, dte, rows, asOf, error }
 */
export async function fetchChainQuotes(accountId, token, expiry) {
  if (!accountId) throw new Error("An account is required.");
  if (!token || !expiry) throw new Error("A token and an expiry are required.");

  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`, [accountId]);
  if (!rows.length) throw new Error("No such account.");
  const acct = rows[0];
  const venue = isAlpacaKey(acct.api_key) ? "alpaca" : "deribit";

  let contracts = [];
  let underlying = null;
  // When the venue last moved these quotes. Outside US market hours Alpaca
  // keeps serving Friday's book while the underlying goes on trading, and a
  // chain priced off a live spot against a stale option market will not hold
  // put-call parity -- so the grid is told, rather than left to present the
  // mismatch as though both halves were current.
  let quoteAt = null;

  if (venue === "alpaca") {
    // The spot price and the chain are independent calls, so they go together
    // rather than one after the other.
    const [chain, spot] = await Promise.allSettled([
      alpacaExpiry(token, expiry, acct),
      // HIP-3 first, the same order the rest of the app prices an underlying
      // in, so the grid's spot agrees with the simulator's futures price.
      hip3Price(token).then((p) => p ?? null).catch(() => null),
    ]);
    if (chain.status === "rejected") throw chain.reason;
    contracts = chain.value.contracts;
    quoteAt = chain.value.quoteAt;
    underlying = spot.status === "fulfilled" ? spot.value : null;
    if (underlying === null) {
      const u = await fetchUnderlying(token, acct.api_key, acct.api_secret).catch(() => null);
      underlying = num(u?.mid ?? u?.price ?? null);
    }
  } else {
    const out = await deribitExpiry(token, expiry, acct);
    contracts = out.contracts;
    underlying = out.underlying;
  }

  return {
    venue,
    token: String(token).toUpperCase(),
    expiry,
    dte: dteOf(expiry),
    underlying,
    quoteAt,
    rows: buildChainRows({ contracts, underlying, expiry }),
    asOf: new Date().toISOString(),
  };
}

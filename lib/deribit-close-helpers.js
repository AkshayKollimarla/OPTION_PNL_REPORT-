/**
 * Shared Deribit helpers for the auto-close workers (single-leg + combo).
 * Extracted so both workers use the exact same, already-debugged logic for
 * auth, collateral (token-aware, not hardcoded to ETH), tick rounding,
 * inverse-future amount conversion, and position reconciliation — instead
 * of drifting out of sync if fixed in only one place.
 */

import pool from "./options-db.js";

export const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
export const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const AUTH_CACHE_TTL_MS = 55_000; // re-auth every ~55 s

const _authCache = {}; // { accountId: { token, base, testnet, expiresAt } }

// Deribit's maintenance page (and some CDN/edge error pages) return HTML
// with a non-2xx status instead of the usual JSON-RPC envelope. Tagging
// that distinctly (err.isExchangeOutage) lets the auto-close workers tell
// "Deribit itself is down" apart from a genuine per-job error — an outage
// should make the job keep retrying indefinitely, not count toward the
// give-up threshold and get marked "failed" while positions sit open.
async function _fetchJsonOrOutage(url, opts) {
  const res = await fetch(url, opts);
  try {
    return await res.json();
  } catch {
    const err = new Error(`Deribit returned a non-JSON response (HTTP ${res.status}) — likely under maintenance`);
    err.isExchangeOutage = true;
    throw err;
  }
}

export async function rpc(base, method, params, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const json = await _fetchJsonOrOutage(`${base}/${method}`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (json.error) throw new Error(`${json.error.message ?? JSON.stringify(json.error)} (code ${json.error.code})`);
  return json.result;
}

export async function auth(accountId) {
  const cached = _authCache[accountId];
  if (cached && cached.expiresAt > Date.now()) return cached;

  const [[acct]] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id=?`, [accountId]
  );
  if (!acct) throw new Error(`Account ${accountId} not found`);
  const base = acct.testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const r    = await rpc(base, "public/auth", {
    grant_type:    "client_credentials",
    client_id:     acct.api_key.trim(),
    client_secret: acct.api_secret.trim(),
  });
  const entry = { token: r.access_token, base, testnet: !!acct.testnet, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
  _authCache[accountId] = entry;
  return entry;
}

// Inverse contracts (ETH, BTC) hold collateral in the coin itself. Linear
// USDC-margined contracts (SOL_USDC, XRP_USDC, ...) settle entirely in USDC —
// there is no separate coin wallet on Deribit for those.
export function coinLegFor(strategyToken) {
  const t = (strategyToken || "ETH").toUpperCase();
  if (t.includes("_USDC") || t.includes("_USDT")) return null;
  return t;
}

// Fetches whichever coin's wallet the strategy actually uses — token-aware,
// not hardcoded to ETH.
export async function collateral(accountId, strategyToken) {
  const { base, token: accessToken } = await auth(accountId);
  const coinSymbol = coinLegFor(strategyToken);

  const [coinR, usdcR] = await Promise.allSettled([
    coinSymbol
      ? rpc(base, "private/get_account_summary", { currency: coinSymbol, extended: false }, accessToken)
      : Promise.resolve(null),
    rpc(base, "private/get_account_summary", { currency: "USDC", extended: false }, accessToken),
  ]);

  let coinIdx = 0;
  if (coinSymbol) {
    try {
      const r = await fetch(`${base}/public/get_index_price?index_name=${coinSymbol.toLowerCase()}_usd`);
      coinIdx = (await r.json()).result?.index_price ?? 0;
    } catch {}
  }

  const coinEq  = coinSymbol && coinR.status === "fulfilled" ? (coinR.value?.equity ?? 0) : 0;
  const usdcEq  = usdcR.status === "fulfilled" ? (usdcR.value.equity ?? 0) : 0;
  const coinUsd = coinEq * coinIdx;
  return {
    coin_symbol:     coinSymbol || "USDC",
    coin_equity:     coinEq,
    coin_equity_usd: coinUsd,
    usdc_equity:     usdcEq,
    total_usd:       coinUsd + usdcEq,
  };
}

export async function effectiveTick(base, instrument, price) {
  try {
    const r    = await fetch(`${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
    const json = await r.json();
    const info = json.result;
    if (!info) return 0.0001;
    const baseTick = info.tick_size ?? 0.0001;
    const steps    = Array.isArray(info.tick_size_steps) ? info.tick_size_steps : [];
    let tick = baseTick;
    for (const s of steps.sort((a, b) => a.above_price - b.above_price)) {
      if (price >= s.above_price) tick = s.tick_size;
    }
    return tick;
  } catch { return 0.0001; }
}

export function roundToTick(value, tickSize, dir = "buy") {
  if (!tickSize || tickSize <= 0) return value;
  const fn  = dir === "sell" ? Math.ceil : Math.floor;
  const dec = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return parseFloat((fn(value / tickSize) * tickSize).toFixed(dec));
}

// Inverse futures (ETH-PERPETUAL, BTC-PERPETUAL) are quoted in USD notional
// with a fixed contract size (1 USD for ETH, 10 USD for BTC) — "amount" must
// be an integer multiple of contract_size, not a raw coin qty.
//
// Options and linear futures take "amount" as a number of CONTRACTS. For
// BTC/ETH, contract_size is 1 so raw coin qty and contract count coincide.
// Altcoin instruments (SOL_USDC, XRP_USDC, ...) use contract_size > 1 (e.g.
// 1 contract = 10 SOL) — the coin qty must be divided down to contracts.
export async function orderAmount(base, instrument, qty) {
  const absQty = Math.abs(qty);
  let info = null;
  try {
    const r = await fetch(`${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
    info = (await r.json()).result;
  } catch {}
  const isInverseFuture = info?.kind === "future" && info?.future_type && info.future_type !== "linear";
  const contractSize = info?.contract_size || 1;

  if (!isInverseFuture) {
    if (contractSize > 1) return Math.max(1, Math.round(absQty / contractSize));
    return absQty;
  }

  let refPrice = 0;
  try {
    const r = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(instrument)}`);
    const j = (await r.json()).result;
    refPrice = j?.mark_price || j?.last_price || j?.index_price || 0;
  } catch {}
  if (refPrice <= 0) return absQty;

  return Math.max(contractSize, Math.round((absQty * refPrice) / contractSize) * contractSize);
}

export async function placeLimitClose(base, token, instrument, qty, dir) {
  const ticker    = (await _fetchJsonOrOutage(`${base}/public/ticker?instrument_name=${encodeURIComponent(instrument)}`)).result ?? {};
  const markPrice = ticker.mark_price ?? 0;
  const tick   = await effectiveTick(base, instrument, markPrice);
  const price  = roundToTick(Math.max(markPrice, tick), tick, dir);
  const amount = await orderAmount(base, instrument, qty);

  return await rpc(base, `private/${dir}`, {
    instrument_name: instrument,
    amount,
    type:            "limit",
    price,
    post_only:       false,
    reduce_only:     true,
  }, token);
}

export async function placeMarketClose(base, token, instrument, qty, dir) {
  const amount = await orderAmount(base, instrument, qty);
  return await rpc(base, `private/${dir}`, {
    instrument_name: instrument,
    amount,
    type:            "market",
    reduce_only:     true,
  }, token);
}

// Checks the REAL position on the exchange rather than trusting our own
// order tracking. Two failure modes this catches:
//  1. The option expires before a maker order ever fills — Deribit
//     auto-settles it outside of any order we placed, so our order-state
//     polling would otherwise wait forever and any hedge would never close.
//  2. An overlapping/duplicate tick (or the user closing manually) already
//     closed the position — without this check, the next tick would place
//     another close order against a position that's already gone.
// Returns false (not flat) on any API error — never assume closed on an
// error, that would abandon a job that's still actually open.
export async function positionFlat(base, token, instrument) {
  if (!instrument) return true;
  try {
    const pos  = await rpc(base, "private/get_position", { instrument_name: instrument }, token);
    const size = Math.abs(parseFloat(pos?.size ?? 0));
    return size === 0;
  } catch (e) {
    return false;
  }
}

// Has this option's expiration_timestamp already passed? Deliberately
// time-based, not position-based — a job whose option was never actually
// filled would also show as "no position", which would otherwise falsely
// look identical to "expired" and trigger the wrong response.
//
// Only a genuine expiration_timestamp in the past counts as expired. Any
// failure to read one back — network/fetch error, malformed body, a
// maintenance-mode response, get_instrument returning no `result` — returns
// false. Confirmed by a real incident: during a Deribit maintenance window
// this used to treat a missing `result` as "delisted, therefore expired",
// which fired a false "Strike Expired" alert and triggered a premature
// close attempt on a strike that still had two weeks left. Assuming NOT
// expired on any uncertainty is the safe default — it just means the job
// keeps polling, whereas assuming expired can trigger closing a healthy
// position.
export async function isOptionExpired(base, instrument) {
  if (!instrument) return false;
  try {
    const r    = await fetch(`${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
    const json = await r.json();
    const info = json.result;
    if (!info) return false;
    if (info.expiration_timestamp && Date.now() >= info.expiration_timestamp) return true;
    return false;
  } catch {
    return false;
  }
}

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
//
// Two distinct failure modes both get tagged: fetch() itself throwing
// (network-level — DNS, connection refused, "fetch failed" — the request
// never even got a response), and res.json() throwing (a response came
// back but wasn't the expected JSON-RPC body, e.g. an HTML maintenance
// page). Confirmed incident: fetch()-level failures were NOT being caught
// here at all, so a run of network blips exhausted the retry threshold and
// killed a job exactly like the case this whole mechanism exists to avoid.
export async function _fetchJsonOrOutage(url, opts) {
  let res;
  try {
    // cache:"no-store" is MANDATORY, never optional. Next.js patches global
    // fetch and was serving cached Deribit responses to these calls —
    // confirmed live: this route reported SOL_USDC-PERPETUAL mark_price
    // 73.4952 frozen for over an hour while a direct call to the identical
    // endpoint returned 74.6965. Everything routed through rpc() was
    // affected: position sizes, mark prices, PnL, AND account equity (an
    // early failed auth cached a $0 balance that then never refreshed,
    // which is why "Live collateral" was stuck at $0.00). Stale data here
    // is not cosmetic — the auto-close workers poll equity through this
    // same path to decide when to close real positions.
    res = await fetch(url, { ...opts, cache: "no-store" });
  } catch (fetchErr) {
    const err = new Error(`Could not reach Deribit (${fetchErr.message}) — likely a network blip or outage`);
    err.isExchangeOutage = true;
    throw err;
  }
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
  if (json.error) {
    // Deribit's real diagnostic detail lives in error.data.reason (e.g.
    // "bad_ip", "invalid_token") and was previously being dropped entirely —
    // every IP-whitelist rejection surfaced as a generic "unauthorized (code
    // 13009)", indistinguishable from an actually-expired/invalidated token
    // and requiring a full manual re-debug each time it recurred. Surfacing
    // it here means it shows up immediately in job error_msg / Telegram
    // alerts instead.
    const reason = json.error.data?.reason;
    const err = new Error(`${json.error.message ?? JSON.stringify(json.error)}${reason ? ` (${reason})` : ""} (code ${json.error.code})`);
    if (reason === "bad_ip") err.isBadIp = true;
    throw err;
  }
  return json.result;
}

// Deribit allows only ONE active token per API key — any concurrent caller
// for the same account (most commonly the background auto-close worker,
// which re-authenticates on its own ~2s tick) can invalidate a token out
// from under a request that already grabbed it, between when auth() handed
// it out and when the actual RPC call reaches Deribit. Confirmed live: of 3
// concurrent get_positions calls sharing one cached token, 2 came back
// "unauthorized (code 13009)" while the first (which happened to fire first)
// succeeded. rpc()/auth() by themselves don't protect against this — this
// wrapper does, by invalidating the cache and retrying ONCE with a forced
// fresh token whenever a call is rejected as unauthorized. NOTE: this does
// NOT help a "bad_ip" rejection (err.isBadIp) — that's the account's IP
// allowlist rejecting this machine's current public IP outright, not a
// stale-token race, so a retry with yet another token fails identically.
export async function rpcAuthed(accountId, method, params) {
  const { base, token } = await auth(accountId);
  try {
    return await rpc(base, method, params, token);
  } catch (e) {
    if (e.isBadIp || !/unauthorized|code 13009/i.test(e.message)) throw e;
    invalidateAuth(accountId, token);
    const fresh = await auth(accountId);
    return await rpc(base, method, params, fresh.token);
  }
}

// Same protection as rpcAuthed, but for callers that need a higher-level
// helper (placeLimitClose/placeMarketClose) rather than a raw rpc() call —
// those take (base, token, ...) positionally, so this hands them a fresh
// (base, token) pair and retries once if the first attempt comes back
// unauthorized.
export async function withAuthRetry(accountId, fn) {
  const first = await auth(accountId);
  try {
    return await fn(first.base, first.token);
  } catch (e) {
    if (e.isBadIp || !/unauthorized|code 13009/i.test(e.message)) throw e;
    invalidateAuth(accountId, first.token);
    const fresh = await auth(accountId);
    return await fn(fresh.base, fresh.token);
  }
}

// Deribit invalidates a key's PREVIOUS token the instant a new one is
// minted for that same client_id/client_secret — so if two concurrent
// callers for the same account BOTH find the cache empty/expired and BOTH
// fire their own separate public/auth request (a classic thundering-herd
// race), the second mint silently kills the first, and whichever caller
// ends up holding the "loser" token fails. Confirmed live: rpcAuthed's
// retry-on-401 alone didn't fix the missing-positions bug, because the two
// failing concurrent calls (USDC, USDT) each retried by re-authenticating
// AT THE SAME TIME, raced each other, and one still lost. Deduplicating
// concurrent auth() calls into a single shared in-flight request — so every
// caller gets the exact same token instead of racing to mint their own — is
// what actually closes the race.
const _authInFlight = {};

export async function auth(accountId) {
  const cached = _authCache[accountId];
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (_authInFlight[accountId]) return _authInFlight[accountId];

  const inFlight = (async () => {
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
  })();
  _authInFlight[accountId] = inFlight;
  try {
    return await inFlight;
  } finally {
    delete _authInFlight[accountId];
  }
}

// Drop a cached token immediately instead of waiting out AUTH_CACHE_TTL_MS.
// Deribit only allows one active session per API key — anything else
// authenticating against the same account (a manual order from the UI, a
// second job) invalidates whatever token is currently cached here. Without
// this, a worker that gets "unauthorized (code 13009)" keeps retrying the
// SAME dead token for up to another 55s, which can burn through the whole
// consecutive-failure threshold before the cache would have refreshed on
// its own.
//
// staleToken, when passed, makes this a no-op if the cache no longer holds
// that exact token — i.e. someone else (another concurrent retry for the
// same account) already refreshed it. Without this guard, two callers
// failing on the same bad token at the same time would each invalidate
// after the other's retry already installed a good one, wiping a token that
// was never actually stale.
export function invalidateAuth(accountId, staleToken) {
  if (staleToken != null && _authCache[accountId]?.token !== staleToken) return;
  delete _authCache[accountId];
}

// Inverse contracts (ETH, BTC) hold collateral in the coin itself. Linear
// USDC-margined contracts (SOL_USDC, XRP_USDC, ...) settle entirely in USDC —
// there is no separate coin wallet on Deribit for those.
// A strategy's stored "token" is not always a bare coin symbol — some rows
// carry a human batch label instead, e.g. "BTC-6THJULY-HFT3". Deribit only
// accepts a real currency, so everything from the first "-" onward is
// dropped as a label suffix. Compound tickers survive intact (they use an
// underscore: "SOL_USDC" contains no "-") and plain symbols are unaffected.
// Without this, such a strategy resolves to a currency Deribit rejects: its
// positions never match and its coin wallet is skipped in the collateral
// total — confirmed on an account whose only open position, a real BTC
// option, was invisible to the exit screen.
export function normalizeToken(strategyToken) {
  return (strategyToken || "").toUpperCase().split("-")[0];
}

export function coinLegFor(strategyToken) {
  const t = normalizeToken(strategyToken) || "ETH";
  if (t.includes("_USDC") || t.includes("_USDT")) return null;
  return t;
}

// Fetches whichever coin's wallet the strategy actually uses — token-aware,
// not hardcoded to ETH.
export async function collateral(accountId, strategyToken) {
  const { base } = await auth(accountId);
  const coinSymbol = coinLegFor(strategyToken);

  // Each call goes through rpcAuthed independently (not one shared token)
  // so that if a concurrent caller (typically the auto-close worker's own
  // polling tick) invalidates the cached token between these two, each one
  // still recovers on its own instead of both silently reporting 0 equity.
  const [coinR, usdcR] = await Promise.allSettled([
    coinSymbol
      ? rpcAuthed(accountId, "private/get_account_summary", { currency: coinSymbol, extended: false })
      : Promise.resolve(null),
    rpcAuthed(accountId, "private/get_account_summary", { currency: "USDC", extended: false }),
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

// min_trade_amount / contract_size for an instrument. Needed when closing a
// hedge in proportion to how much of its option leg has filled: the computed
// slice is an arbitrary fraction, and anything under min_trade_amount is
// rejected by Deribit outright, so slices have to accumulate until they're
// large enough to actually send.
export async function instrumentMeta(base, instrument) {
  try {
    const r = await fetch(
      `${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`,
      { cache: "no-store" }
    );
    const info = (await r.json()).result;
    if (!info) return null;
    return {
      contract_size:    info.contract_size ?? 1,
      min_trade_amount: info.min_trade_amount ?? 0,
    };
  } catch { return null; }
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
// Options and linear futures take "amount" denominated in the UNDERLYING
// COIN, which must be an integer multiple of contract_size. For BTC/ETH,
// contract_size is 1 so any coin qty qualifies. Altcoins (SOL_USDC,
// XRP_USDC, ...) use contract_size > 1 (1 contract = 10 SOL), so the coin
// qty gets rounded to the nearest valid multiple — it is NOT converted into
// a contract count. Sending the contract count (20 SOL → "2") lands below
// min_trade_amount and Deribit rejects it with "Invalid params (-32602)" —
// the identical failure already fixed once in app/api/deribit-order/route.js
// on the ENTRY path; this is the same bug on the CLOSE path, which would
// have silently blocked the auto-close worker from ever closing a SOL leg.
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
    if (contractSize > 1) return Math.max(1, Math.round(absQty / contractSize)) * contractSize;
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

// exactAmount=true means qty is ALREADY in the units Deribit's "amount"
// expects and must be sent through untouched. Callers that read a size
// straight off private/get_positions are in exactly that position, and for
// an INVERSE future running it through orderAmount() would be catastrophic:
// get_positions reports BTC-PERPETUAL size as USD notional (-1500), which
// orderAmount would treat as a coin qty and multiply by ~64,600 — a 1500 USD
// close request becoming a ~97,000,000 USD one. reduce_only would likely cap
// the damage, but a close path must never depend on that backstop.
// Reconciles against the exchange before placing a close order, so the book —
// not our own bookkeeping — is the source of truth for "is an order already
// working?".
//
// A tracked order id can be lost in ways no amount of local care prevents: the
// process restarting between placing an order and persisting its id, a DB
// write failing, or (the confirmed case) two overlapping ticks each placing
// one and racing the write. The result was duplicate reduce_only sells resting
// on the same position with the leg row showing opt_order_id NULL.
//
// Only orders that are unmistakably OURS are touched: same instrument, same
// direction, and reduce_only — a close order's signature. A user's own manual
// order on the same instrument is never reduce_only in the same direction by
// coincidence, and is left completely alone. Returns the order to adopt, or
// null if the caller should place a fresh one.
export async function adoptOrCleanupCloseOrders(base, token, instrument, dir) {
  let orders;
  try {
    orders = await rpc(base, "private/get_open_orders_by_instrument", { instrument_name: instrument }, token);
  } catch {
    return null; // couldn't check — caller proceeds as before
  }
  const ours = (orders || []).filter(o => o.direction === dir && o.reduce_only);
  if (!ours.length) return null;

  // Keep the oldest and cancel the rest: any extra is a duplicate of the same
  // close, and leaving several working means several can fill.
  ours.sort((a, b) => (a.creation_timestamp || 0) - (b.creation_timestamp || 0));
  for (const extra of ours.slice(1)) {
    try { await rpc(base, "private/cancel", { order_id: extra.order_id }, token); } catch { /* already gone */ }
  }
  return { order: ours[0], cancelledDuplicates: ours.length - 1 };
}

// Cancels every close order this app has working on an instrument. Used when
// a job is stopped: setting status='stopped' only ends the polling loop, it
// does nothing to orders already resting on the book. Those then sit there
// unmanaged — no longer re-quoted as the mark moves, but still liable to fill
// at a price nobody is watching. Confirmed after a stop: two reduce_only buys
// were left resting with the job long since halted.
//
// Same ownership test as adoptOrCleanupCloseOrders — instrument + direction +
// reduce_only — so a user's own manual orders are never cancelled.
export async function cancelCloseOrders(base, token, instrument, dir) {
  let orders;
  try {
    orders = await rpc(base, "private/get_open_orders_by_instrument", { instrument_name: instrument }, token);
  } catch {
    return 0;
  }
  let n = 0;
  for (const o of (orders || []).filter(x => x.direction === dir && x.reduce_only)) {
    try { await rpc(base, "private/cancel", { order_id: o.order_id }, token); n++; }
    catch { /* already filled or gone */ }
  }
  return n;
}

// The price a close order should be placed at.
//
//   passive (default) — mark, rounded AWAY from the market (floor to buy,
//     ceil to sell). Adds to the book and waits. Costs nothing but may never
//     fill: on a coarse tick this parks the order a full tick from mark, and
//     SOL_USDC options tick at 0.1 against a ~0.25 premium.
//
//   crossing — the OPPOSITE touch: pay the ask to buy, hit the bid to sell.
//     There is already an order resting there, so this fills immediately.
//     Still a limit order, never a market one, so the touch is a hard bound
//     on the fill price — it cannot be swept through a thin book.
//
// Crossing costs the spread. On Deribit OPTIONS it costs nothing else:
// maker_commission and taker_commission are both 0.0003, so the usual
// "stay maker to save fees" argument does not apply there (it does on
// futures, where maker is 0% against 0.05% taker).
export async function closePriceFor(base, instrument, dir, crossSpread = false) {
  const ticker    = (await _fetchJsonOrOutage(`${base}/public/ticker?instrument_name=${encodeURIComponent(instrument)}`)).result ?? {};
  const markPrice = ticker.mark_price ?? 0;
  const tick      = await effectiveTick(base, instrument, markPrice);

  if (crossSpread) {
    const touch = dir === "buy" ? ticker.best_ask_price : ticker.best_bid_price;
    if (touch > 0) {
      // Round TOWARD the market so the order still reaches the resting one:
      // rounding a buy down (or a sell up) would leave it short of the touch
      // and back to resting passively — the exact thing crossing is for.
      return { price: roundToTick(touch, tick, dir === "buy" ? "sell" : "buy"), tick, crossed: true };
    }
    // No touch on that side (empty book) — nothing to cross into, so fall
    // through to the passive price rather than inventing one.
  }
  return { price: roundToTick(Math.max(markPrice, tick), tick, dir), tick, crossed: false };
}

// Places at an EXPLICIT price the caller has already decided on. Needed when
// that decision involves state this helper can't see — the combo worker
// clamps a crossing price against the level the leg first crossed at, so it
// cannot walk down the book across successive re-quotes.
export async function placeLimitCloseAt(base, token, instrument, qty, dir, price, exactAmount = false) {
  const amount = exactAmount ? Math.abs(qty) : await orderAmount(base, instrument, qty);
  return await rpc(base, `private/${dir}`, {
    instrument_name: instrument,
    amount,
    type:            "limit",
    price,
    post_only:       false,
    reduce_only:     true,
  }, token);
}

export async function placeLimitClose(base, token, instrument, qty, dir, exactAmount = false, crossSpread = false) {
  const { price } = await closePriceFor(base, instrument, dir, crossSpread);
  return await placeLimitCloseAt(base, token, instrument, qty, dir, price, exactAmount);
}

export async function placeMarketClose(base, token, instrument, qty, dir, exactAmount = false) {
  const amount = exactAmount ? Math.abs(qty) : await orderAmount(base, instrument, qty);
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
// Real position size on the exchange right now (absolute value), or null if
// it couldn't be determined. Deliberately null, not 0, on error — callers
// must not mistake "couldn't check" for "flat".
//
// Returned in the units Deribit's order "amount" parameter expects for this
// instrument, so the value can be handed straight to placeLimitClose /
// placeMarketClose with exactAmount=true:
//   inverse future (BTC-PERPETUAL)      → size, already USD notional
//   linear future (SOL_USDC-PERPETUAL)  → size_currency, the coin qty
//                                         (size there is USD notional)
//   option                              → size, the coin qty
// Taking raw "size" for a LINEAR future was a live overshoot risk: a 10 SOL
// hedge reports size ≈ 745 (USD), and closing "745" of a 10 SOL position is
// 74x the real exposure.
export async function livePositionSize(base, token, instrument) {
  if (!instrument) return 0;
  try {
    const pos = await rpc(base, "private/get_position", { instrument_name: instrument }, token);
    if (!pos) return 0;
    const isLinearFuture = pos.kind === "future" && /_USDC-|_USDT-/i.test(instrument);
    if (isLinearFuture && pos.size_currency != null) {
      return Math.abs(parseFloat(pos.size_currency));
    }
    return Math.abs(parseFloat(pos.size ?? 0));
  } catch (e) {
    return null;
  }
}

export async function positionFlat(base, token, instrument) {
  const size = await livePositionSize(base, token, instrument);
  if (size === null) return false;
  return size === 0;
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

// Live positions, and closing one.
//
// Two venues answer, told apart by the credential rather than by the
// account's exchange label -- an Alpaca key id is "PK..." on paper and
// "AK..." on live, and the label on this book is a reporting grouping, not a
// routing decision (see lib/alpaca.js).
//
// Everything normalises onto one row shape so the page does not care which
// venue a position came from:
//
//   { accountId, account, venue, symbol, assetClass, side, size, avgPrice,
//     markPrice, pnl, pnlPct, value }
//
// size is always POSITIVE and `side` carries the direction, because a short
// is reported as a negative quantity by one venue and as direction="sell" by
// the other, and one of those has to win.

import pool from "./options-db.js";
import { isAlpacaKey } from "./alpaca.js";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const ALPACA_PAPER = "https://paper-api.alpaca.markets";
const ALPACA_LIVE = "https://api.alpaca.markets";
const ALPACA_DATA = "https://data.alpaca.markets";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function listAccounts() {
  const [rows] = await pool.query(
    `SELECT id, name, exchange, api_key, api_secret, testnet FROM trading_accounts ORDER BY name`);
  return rows.map((r) => ({ ...r, venue: isAlpacaKey(r.api_key) ? "alpaca" : "deribit" }));
}

/* ── Alpaca ───────────────────────────────────────────────────────────── */

const alpacaBase = (key) => (/^AK/i.test(String(key || "").trim()) ? ALPACA_LIVE : ALPACA_PAPER);

async function alpacaCall(url, acct, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": acct.api_key,
      "APCA-API-SECRET-KEY": acct.api_secret,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.message || body?.error || text.slice(0, 200) || `HTTP ${res.status}`);
  }
  return body;
}

async function alpacaPositions(acct) {
  const rows = await alpacaCall(`${alpacaBase(acct.api_key)}/v2/positions`, acct);
  return (rows || []).map((p) => {
    const qty = num(p.qty) ?? 0;
    return {
      accountId: acct.id,
      account: acct.name,
      venue: "alpaca",
      symbol: p.symbol,
      assetClass: p.asset_class === "us_option" ? "option" : "equity",
      // Alpaca signs the quantity and also sends a side; the sign is the one
      // that survives, so a short reads as short however it was reported.
      side: qty < 0 ? "short" : "long",
      size: Math.abs(qty),
      avgPrice: num(p.avg_entry_price),
      markPrice: num(p.current_price),
      pnl: num(p.unrealized_pl),
      pnlPct: num(p.unrealized_plpc) === null ? null : num(p.unrealized_plpc) * 100,
      value: num(p.market_value),
    };
  });
}

/**
 * The price a resting close should sit at.
 *
 * To rest rather than take, a sell is posted at the ask and a buy at the bid:
 * posting a sell at the bid would cross into it and pay the spread, which is
 * the opposite of what "maker only" is for.
 */
async function alpacaQuote(acct, symbol, assetClass) {
  if (assetClass === "option") {
    const url = `${ALPACA_DATA}/v1beta1/options/snapshots?symbols=${encodeURIComponent(symbol)}&feed=indicative`;
    const body = await alpacaCall(url, acct);
    const q = body?.snapshots?.[symbol]?.latestQuote || {};
    return { bid: num(q.bp), ask: num(q.ap) };
  }
  // delayed_sip rather than the default iex: outside regular hours iex keeps
  // serving the closing auction print, which is not a price anything will
  // fill against. See lib/alpaca.js for the long version.
  const url = `${ALPACA_DATA}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=delayed_sip`;
  const body = await alpacaCall(url, acct);
  const q = body?.quote || {};
  return { bid: num(q.bp), ask: num(q.ap) };
}

async function alpacaCloseMaker(acct, position) {
  const side = position.side === "long" ? "sell" : "buy";
  const { bid, ask } = await alpacaQuote(acct, position.symbol, position.assetClass);
  const resting = side === "sell" ? ask : bid;
  if (!(resting > 0)) {
    throw new Error(`No ${side === "sell" ? "ask" : "bid"} to rest against for ${position.symbol}, so a maker order has no price.`);
  }
  // Rounded to the cent the venue quotes in; an unrounded limit is rejected.
  const limit = Math.round(resting * 100) / 100;

  const order = {
    symbol: position.symbol,
    qty: String(position.size),
    side,
    type: "limit",
    time_in_force: "day",
    limit_price: String(limit),
  };
  const placed = await alpacaCall(`${alpacaBase(acct.api_key)}/v2/orders`, acct, {
    method: "POST",
    body: JSON.stringify(order),
  });
  return {
    venue: "alpaca",
    orderId: placed?.id || null,
    side,
    qty: position.size,
    limit,
    // Said plainly rather than implied: Alpaca has no post-only flag for
    // equities or options. Resting at the touch is as close as the venue
    // allows, and a fast market can still fill it as a taker.
    makerOnly: false,
    note: "Limit order resting at the touch. Alpaca has no post-only flag, so a fast market could still take it.",
  };
}

/* ── Deribit ──────────────────────────────────────────────────────────── */

const deribitBase = (acct) => (acct.testnet ? DERIBIT_TEST : DERIBIT_LIVE);

async function deribitAuth(acct) {
  const base = deribitBase(acct);
  const url = `${base}/public/auth?grant_type=client_credentials`
    + `&client_id=${encodeURIComponent(acct.api_key)}&client_secret=${encodeURIComponent(acct.api_secret)}`;
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  const token = body?.result?.access_token;
  if (!token) {
    throw new Error(body?.error?.message || body?.error?.data?.reason || "Deribit would not authenticate this key.");
  }
  return token;
}

async function deribitRpc(acct, token, method, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const res = await fetch(`${deribitBase(acct)}/${method}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await res.json();
  if (body?.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body?.result;
}

async function deribitPositions(acct) {
  const token = await deribitAuth(acct);
  // Every settlement currency the book has ever used. Asked for each, because
  // Deribit scopes positions by currency and a missing one is simply absent
  // rather than an error.
  const currencies = ["BTC", "ETH", "SOL", "USDC", "USDT"];
  const results = await Promise.allSettled(
    currencies.map((c) => deribitRpc(acct, token, "private/get_positions", { currency: c })));

  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value || []) {
      if (!p.instrument_name || seen.has(p.instrument_name)) continue;
      if (Math.abs(p.size) <= 1e-9) continue;
      seen.add(p.instrument_name);
      out.push({
        accountId: acct.id,
        account: acct.name,
        venue: "deribit",
        symbol: p.instrument_name,
        assetClass: p.kind === "option" ? "option" : "future",
        side: p.direction === "sell" || p.size < 0 ? "short" : "long",
        size: Math.abs(num(p.size) ?? 0),
        avgPrice: num(p.average_price_usd ?? p.average_price),
        markPrice: num(p.mark_price_usd ?? p.mark_price),
        pnl: num(p.floating_profit_loss_usd ?? p.floating_profit_loss),
        pnlPct: null,
        value: null,
      });
    }
  }
  return out;
}

async function deribitCloseMaker(acct, position) {
  const token = await deribitAuth(acct);
  const dir = position.side === "long" ? "sell" : "buy";
  const ticker = await deribitRpc(acct, token, "public/ticker", { instrument_name: position.symbol });
  const resting = dir === "sell" ? num(ticker?.best_ask_price) : num(ticker?.best_bid_price);
  if (!(resting > 0)) {
    throw new Error(`No ${dir === "sell" ? "ask" : "bid"} to rest against for ${position.symbol}.`);
  }
  const placed = await deribitRpc(acct, token, `private/${dir}`, {
    instrument_name: position.symbol,
    amount: position.size,
    type: "limit",
    price: resting,
    // The two that make this what was asked for: it may only ever add
    // liquidity, and it may only ever reduce the position.
    post_only: true,
    reject_post_only: true,
    reduce_only: true,
  });
  return {
    venue: "deribit",
    orderId: placed?.order?.order_id || null,
    side: dir,
    qty: position.size,
    limit: resting,
    makerOnly: true,
    note: "Post-only and reduce-only: it can only rest, and can only close.",
  };
}

/* ── What the page and the api use ────────────────────────────────────── */

/** Positions across one account, or every account when accountId is null. */
export async function fetchPositions(accountId = null) {
  const accounts = (await listAccounts())
    .filter((a) => accountId === null || String(a.id) === String(accountId));

  const results = await Promise.allSettled(accounts.map(async (a) => {
    const rows = a.venue === "alpaca" ? await alpacaPositions(a) : await deribitPositions(a);
    return { account: a, rows };
  }));

  const positions = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") positions.push(...r.value.rows);
    // One venue being unreachable must not blank the others, so the failure
    // is reported beside whatever did answer.
    else errors.push({ account: accounts[i].name, error: r.reason?.message || String(r.reason) });
  });

  positions.sort((a, b) => a.account.localeCompare(b.account) || a.symbol.localeCompare(b.symbol));
  return { positions, errors, accounts: accounts.map(({ id, name, venue }) => ({ id, name, venue })) };
}

/** Close one position, resting rather than taking. */
export async function closePosition({ accountId, symbol }) {
  const acct = (await listAccounts()).find((a) => String(a.id) === String(accountId));
  if (!acct) throw new Error("No such account.");

  // Re-read the position from the venue rather than trusting what the page
  // last saw: size, and even existence, can have changed since it rendered.
  const live = acct.venue === "alpaca" ? await alpacaPositions(acct) : await deribitPositions(acct);
  const position = live.find((p) => p.symbol === symbol);
  if (!position) throw new Error(`${symbol} is no longer open on ${acct.name}.`);

  return acct.venue === "alpaca"
    ? alpacaCloseMaker(acct, position)
    : deribitCloseMaker(acct, position);
}

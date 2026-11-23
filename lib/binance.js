// Binance European options, read-only.
//
// The fourth venue. Unlike Deribit it is USDT-settled throughout, so every
// premium here is already in dollars -- none of the coin conversion that made
// an ETH option read 0.0097 instead of $17.83, and no instrument has to be
// classified linear or inverse before its price means anything.
//
// It also publishes the greeks and both implied volatilities itself, where
// Deribit gives a mark IV and the rest is solved locally. Where the venue
// says something, the venue is believed.
//
// Everything in this file is PUBLIC. Reading a chain needs no key, which is
// worth saying plainly: an account labelled binance is not what makes this
// work, and no credential is sent anywhere to make it work. Balances,
// positions and order placement all need signed requests and are NOT here --
// see the note at the bottom.
//
// Instruments are named BTC-261225-85000-C: coin, YYMMDD, strike, C or P.
// Close enough to Deribit's BTC-25DEC26-85000-C to be confusing, and
// different enough that one parser cannot serve both.

const EAPI = "https://eapi.binance.com/eapi/v1";
const FAPI = "https://fapi.binance.com/fapi/v1";

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The coin behind a stored token: BTCUSDT, BTC_USDC and BTC are all BTC. */
export const coinOf = (token) =>
  String(token || "").toUpperCase().replace(/[-_]?(USDT|USDC|PERP|PERPETUAL).*$/, "") || "BTC";

/**
 * BTC-261225-85000-C -> { coin, expiry: "2026-12-25", strike, optType }
 *
 * The date is two-digit-year first, which is the opposite way round from
 * Deribit and the reason this is parsed rather than shared.
 */
export function parseInstrument(name) {
  const m = /^([A-Z]+)-(\d{6})-([\d.]+)-([CP])$/.exec(String(name || "").toUpperCase());
  if (!m) return null;
  const [, coin, yymmdd, strike, cp] = m;
  const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return { coin, expiry, strike: Number(strike), optType: cp === "C" ? "CALL" : "PUT", instrument: name };
}

/** The reverse, for naming a contract the app already knows the parts of. */
export function buildInstrument(token, expiry, strike, optType) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(expiry || ""));
  if (!m) return null;
  const k = Number(strike);
  if (!Number.isFinite(k) || k <= 0) return null;
  // Binance writes a whole strike without a decimal point: 85000, not 85000.0.
  const strikeText = Number.isInteger(k) ? String(k) : String(k);
  return `${coinOf(token)}-${m[1].slice(2)}${m[2]}${m[3]}-${strikeText}-`
    + `${String(optType).toUpperCase().startsWith("C") ? "C" : "P"}`;
}

async function get(url, { timeout = 15_000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const res = await fetch(url, { cache: "no-store", signal: abort.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // Binance reports its own errors in the body with a negative code.
      const msg = body?.msg || `HTTP ${res.status}`;
      throw new Error(`Binance: ${msg}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// The three public tables, cached briefly and shared.
//
// Each is the WHOLE option board -- 1,784 rows and growing -- because Binance
// has no per-expiry endpoint and filtering by underlying still returns every
// expiry for it. One fetch a second serves every caller rather than each
// chain poll pulling the board again.
const TTL_MS = 900;
const _c = globalThis.__binanceCache || (globalThis.__binanceCache = { at: new Map(), val: new Map(), inFlight: new Map() });

async function cached(key, load) {
  const at = _c.at.get(key);
  if (at && Date.now() - at < TTL_MS) return _c.val.get(key);

  let pending = _c.inFlight.get(key);
  if (!pending) {
    pending = load()
      .then((v) => { _c.val.set(key, v); _c.at.set(key, Date.now()); return v; })
      .finally(() => _c.inFlight.delete(key));
    _c.inFlight.set(key, pending);
  }
  try {
    return await pending;
  } catch (err) {
    // A stale board beats a blank grid; a missed poll should not empty the
    // screen. Only a key that has never loaded throws.
    if (_c.val.has(key)) return _c.val.get(key);
    throw err;
  }
}

const instruments = () => cached("info", async () => {
  const body = await get(`${EAPI}/exchangeInfo`);
  return (body?.optionSymbols || []).map((s) => ({
    ...parseInstrument(s.symbol),
    underlying: s.underlying,
    unit: num(s.unit) ?? 1,
    minQty: num(s.minQty),
  })).filter((x) => x && x.coin);
});

const marks = () => cached("mark", async () => {
  const rows = await get(`${EAPI}/mark`);
  const by = new Map();
  for (const r of rows || []) by.set(r.symbol, r);
  return by;
});

const tickers = () => cached("ticker", async () => {
  const rows = await get(`${EAPI}/ticker`);
  const by = new Map();
  for (const r of rows || []) by.set(r.symbol, r);
  return by;
});

/** Every coin Binance lists options on, newest board first. */
export async function symbols() {
  const list = await instruments();
  return [...new Set(list.map((i) => i.coin))].sort();
}

/**
 * The expiries listed for a coin, each with its strikes.
 *
 * The same shape the Deribit branch returns, so the page that draws it does
 * not need to know which venue answered. The label is the date itself --
 * Binance has no other name for an expiry, and inventing Deribit's
 * 25DEC26 style for a venue that does not use it would be a lie told for
 * tidiness.
 */
export async function chain(token) {
  const coin = coinOf(token);
  const list = (await instruments()).filter((i) => i.coin === coin);
  if (!list.length) return { expiries: [], error: `Binance lists no options on ${coin}.` };

  const byExpiry = new Map();
  for (const i of list) {
    if (!byExpiry.has(i.expiry)) byExpiry.set(i.expiry, new Set());
    byExpiry.get(i.expiry).add(i.strike);
  }
  const expiries = [...byExpiry.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, strikes]) => ({ date, label: date, strikes: [...strikes].sort((a, b) => a - b) }));
  return { expiries };
}

/**
 * The perpetual's mark, which is what fut_entry_price holds for these.
 *
 * From the USDT-margined perpetual, which is the one that matches a
 * USDT-settled option. premiumIndex carries the mark and the index together,
 * so the two cannot be fetched a moment apart and disagree.
 */
export async function futures(token) {
  const pair = `${coinOf(token)}USDT`;
  const body = await get(`${FAPI}/premiumIndex?symbol=${encodeURIComponent(pair)}`);
  const mark = num(body?.markPrice);
  const index = num(body?.indexPrice);
  if (!(mark > 0)) throw new Error(`Binance has no mark price for ${pair}.`);
  return {
    mark_price: mark,
    index_price: index ?? mark,
    instrument: pair,
    best_bid: null,
    best_ask: null,
    mid_price: mark,
    feed: "binance",
    quote_at: new Date().toISOString(),
    delayed_minutes: 0,
    exact_price: true,
  };
}

/** The underlying price the option board itself is marked against. */
export async function underlyingPrice(token) {
  const f = await futures(token).catch(() => null);
  return f?.index_price ?? f?.mark_price ?? null;
}

/**
 * One contract, in the shape the entry pages read.
 *
 * Every figure is already in USDT, so mark_price_raw and mark_price_usd are
 * the same number and is_linear is true. They are both reported anyway, so a
 * caller written for Deribit reads this without a special case.
 */
export async function ticker(instrument) {
  const parts = parseInstrument(instrument);
  if (!parts) throw new Error(`Not a Binance option: ${instrument}`);
  const [mk, tk, under] = await Promise.all([
    marks(), tickers(), underlyingPrice(parts.coin),
  ]);
  const m = mk.get(parts.instrument);
  const t = tk.get(parts.instrument);
  if (!m && !t) throw new Error(`Binance does not list ${instrument}.`);

  const mark = num(m?.markPrice) ?? 0;
  const bid = num(t?.bidPrice) ?? 0;
  const ask = num(t?.askPrice) ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : mark;

  return {
    tick_size: null,
    mark_price_raw: mark,
    mark_price_usd: mark,
    underlying_price: under,
    // Binance reports IV as a fraction; the app shows a percentage, which is
    // what mark_iv means everywhere else here.
    mark_iv: num(m?.markIV) !== null ? num(m.markIV) * 100 : null,
    best_bid_usd: bid,
    best_ask_usd: ask,
    best_bid_raw: bid,
    best_ask_raw: ask,
    mid_price_raw: mid,
    mid_price_usd: mid,
    is_linear: true,
    instrument: parts.instrument,
    // Published by the venue rather than solved here.
    greeks: {
      delta: num(m?.delta), gamma: num(m?.gamma),
      theta: num(m?.theta), vega: num(m?.vega),
    },
  };
}

/**
 * Every contract on one expiry, for the chain grid.
 *
 * The same shape lib/chain-quotes.js builds for the other venues:
 * { contracts: [{ strike, optType, bid, ask, mark, iv, volume, oi, instrument }],
 *   underlying }
 */
export async function expiryBoard(token, expiry) {
  const coin = coinOf(token);
  const [list, mk, tk, under] = await Promise.all([
    instruments(), marks(), tickers(), underlyingPrice(coin),
  ]);

  const contracts = [];
  for (const i of list) {
    if (i.coin !== coin || i.expiry !== expiry) continue;
    const m = mk.get(i.instrument);
    const t = tk.get(i.instrument);
    contracts.push({
      strike: i.strike,
      optType: i.optType,
      bid: num(t?.bidPrice),
      ask: num(t?.askPrice),
      mark: num(m?.markPrice),
      // Percent, as the grid's other venues report it.
      iv: num(m?.markIV) !== null ? num(m.markIV) * 100 : null,
      volume: num(t?.volume),
      // Binance publishes no open interest on this endpoint. Null, not zero:
      // zero is a reading and this is its absence.
      oi: null,
      instrument: i.instrument,
    });
  }
  return { contracts, underlying: under };
}

/**
 * Mids for several contracts at once, keyed as lib/live-legs.js keys them.
 *
 * One board fetch however many legs are asked for, where Deribit needs a
 * request per contract.
 */
export async function legMids(legs) {
  const [mk, tk] = await Promise.all([marks(), tickers()]);
  const out = {};
  for (const l of legs || []) {
    const name = buildInstrument(l.token, l.expiry, l.strike, l.optType);
    if (!name) continue;
    const t = tk.get(name);
    const bid = num(t?.bidPrice);
    const ask = num(t?.askPrice);
    // A mid only, and only from a two-sided quote -- the same rule the rest
    // of the app prices options by, so a figure here agrees with the one
    // beside it. The mark is NOT substituted: it is a venue's model, not a
    // price anyone offered.
    const mid = bid > 0 && ask > 0 ? Math.round(((bid + ask) / 2) * 1e6) / 1e6 : null;
    out[name] = { mid, bid, ask, instrument: name, mark: num(mk.get(name)?.markPrice) };
  }
  return out;
}

// NOT here, deliberately: balances, positions and order placement.
//
// All three need requests signed with the account's secret, and placing an
// order moves real money. Reading a chain needs no key at all, so the whole
// of the above can be written and checked without a credential being
// involved -- and is worth having on its own, since it is what the entry and
// simulator pages are blocked on. The signed half is a separate piece of
// work with a separate kind of risk, and pretending otherwise by bolting it
// on here is how an untested order path reaches a live account.
export const SIGNED_SUPPORT = false;

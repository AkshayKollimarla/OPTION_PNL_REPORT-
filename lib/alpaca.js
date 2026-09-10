// Alpaca market data for the US-equity options book.
//
// The account that holds these keys is named HYPER-USMARKETS and carries
// exchange = "hyperliquid", because its strategies have to stay grouped with
// the Hyperliquid bot entries they are hedged against. The exchange column is
// therefore a REPORTING label, not a routing decision, and cannot say which
// venue to ask for prices. The credential itself can: an Alpaca key id is
// "PK..." on paper and "AK..." on live, so the key picks the provider and the
// account keeps its reporting identity.
//
// Prices follow the convention already in the book: option prices are per
// share (a $4.75 CRWV call), quantities are in shares (600 = 6 contracts), and
// fut_entry_price is the underlying stock price.

const PAPER_TRADE = "https://paper-api.alpaca.markets";
const LIVE_TRADE = "https://api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

// The options data feed. OPRA is the real consolidated feed and needs its
// agreement signed in the Alpaca dashboard; without it the API answers 403
// "OPRA agreement is not signed". "indicative" is the free derived feed and is
// what this account can read today. Change this one constant once OPRA is
// signed.
const OPTION_FEED = "indicative";

// US options quote in one-cent increments (the penny programme covers the
// liquid names this book trades), so a mid of 4.755 is not a tradable price.
const TICK = 0.01;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Does this credential belong to Alpaca? Paper key ids start PK, live AK.
 */
export function isAlpacaKey(key) {
  return /^(PK|AK)[A-Z0-9]{6,}$/i.test(String(key || "").trim());
}

/**
 * Which venue should price this account. The exchange column wins when it
 * names Alpaca outright; otherwise the credential decides, so an account
 * labelled for its bot counterpart still prices correctly.
 */
export function resolveProvider(row) {
  const exchange = String(row?.exchange || "").toLowerCase();
  if (exchange === "alpaca") return "alpaca";
  if (isAlpacaKey(row?.api_key)) return "alpaca";
  return exchange || "deribit";
}

// Paper and live are separate hosts with separate keys; the key prefix says
// which, and it is more trustworthy here than the account's testnet flag,
// which nothing sets for Alpaca.
function tradeBase(key) {
  return /^AK/i.test(String(key || "").trim()) ? LIVE_TRADE : PAPER_TRADE;
}

async function aFetch(url, key, secret) {
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = body?.message || body?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`Alpaca ${res.status}: ${msg}`);
  }
  return body;
}

/**
 * OCC option symbol: root + YYMMDD + C/P + strike x 1000, zero-padded to 8.
 * AAPL, 2026-09-11, 110, CALL -> AAPL260911C00110000
 */
export function occSymbol(underlying, expiryIso, strike, optType) {
  const d = new Date(`${expiryIso}T00:00:00Z`);
  if (isNaN(d)) return null;
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const cp = String(optType).toUpperCase().startsWith("C") ? "C" : "P";
  // Rounded before padding: a strike of 482.5 is 482500, and floating point
  // must not turn that into 482499.
  const strikeInt = Math.round(Number(strike) * 1000);
  if (!Number.isFinite(strikeInt) || strikeInt <= 0) return null;
  return `${String(underlying).toUpperCase()}${yy}${mm}${dd}${cp}${String(strikeInt).padStart(8, "0")}`;
}

/**
 * Read back the Deribit-style name the option pages build — TOKEN-11SEP26-110-C.
 *
 * Both entry pages compose that name client-side and pass it as `instrument`.
 * Parsing it here means Alpaca support costs those pages no change at all:
 * they keep speaking one instrument format and this module translates.
 *
 * Split from the right, so a root containing a hyphen cannot shift the fields.
 */
export function parseInstrument(instrument) {
  const parts = String(instrument || "").split("-");
  if (parts.length < 4) return null;
  const cp = parts.pop();
  const strike = parts.pop();
  const label = parts.pop();
  const token = parts.join("-");
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/i.exec(label);
  if (!m) return null;
  const monIdx = MONTHS.indexOf(m[2].toUpperCase());
  if (monIdx < 0) return null;
  const expiry = `20${m[3]}-${String(monIdx + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return {
    token: token.toUpperCase(),
    expiry,
    strike: Number(strike),
    optType: cp.toUpperCase().startsWith("C") ? "CALL" : "PUT",
  };
}

export function toExpiryLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d)) return dateStr;
  return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;
}

function roundTick(v) {
  if (!Number.isFinite(v)) return null;
  return parseFloat((Math.round(v / TICK) * TICK).toFixed(2));
}

// The contract list for one underlying runs to a few thousand rows and takes a
// couple of seconds. The chain is refetched whenever the token changes and
// again for the strike dropdown, so a short cache keeps that from being felt.
// Deliberately brief: strikes get added intraday as the underlying moves.
const chainCache = new Map();
const CHAIN_TTL_MS = 60_000;

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/**
 * Active option contracts for an underlying, within a forward window.
 */
export async function fetchContracts(underlying, key, secret, { windowDays = 240 } = {}) {
  const sym = String(underlying).toUpperCase();
  const hit = chainCache.get(sym);
  if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.contracts;

  const base = tradeBase(key);
  const from = isoDaysFromNow(0);
  const to = isoDaysFromNow(windowDays);
  const contracts = [];
  let pageToken = "";
  // Paged rather than assumed single-page: a heavily listed name can exceed
  // the 10,000 cap. Bounded so a runaway cursor cannot loop.
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({
      underlying_symbols: sym,
      status: "active",
      expiration_date_gte: from,
      expiration_date_lte: to,
      limit: "10000",
    });
    if (pageToken) qs.set("page_token", pageToken);
    const body = await aFetch(`${base}/v2/options/contracts?${qs}`, key, secret);
    contracts.push(...(body?.option_contracts || []));
    pageToken = body?.next_page_token || "";
    if (!pageToken) break;
  }
  chainCache.set(sym, { at: Date.now(), contracts });
  return contracts;
}

/**
 * Expiries and their strikes, in the shape the option pages already consume
 * from the Deribit branch.
 */
export async function fetchChain(underlying, key, secret) {
  const contracts = await fetchContracts(underlying, key, secret);
  const byExpiry = new Map();
  for (const c of contracts) {
    if (c.tradable === false) continue;
    const date = c.expiration_date;
    if (!date) continue;
    if (!byExpiry.has(date)) byExpiry.set(date, new Set());
    const strike = Number(c.strike_price);
    if (Number.isFinite(strike)) byExpiry.get(date).add(strike);
  }
  return [...byExpiry.keys()].sort().map((date) => ({
    date,
    label: toExpiryLabel(date),
    strikes: [...byExpiry.get(date)].sort((a, b) => a - b),
  }));
}

/**
 * Latest quote for the underlying stock. This fills fut_entry_price, which for
 * a US-equity strategy is the share price the position is hedged against.
 */
export async function fetchUnderlying(symbol, key, secret) {
  const sym = String(symbol).toUpperCase();
  const [quote, trade] = await Promise.all([
    aFetch(`${DATA}/v2/stocks/${encodeURIComponent(sym)}/quotes/latest`, key, secret).catch(() => null),
    aFetch(`${DATA}/v2/stocks/${encodeURIComponent(sym)}/trades/latest`, key, secret).catch(() => null),
  ]);
  const bid = Number(quote?.quote?.bp) || 0;
  const ask = Number(quote?.quote?.ap) || 0;
  const last = Number(trade?.trade?.p) || 0;
  // Mid when both sides quote, last trade otherwise — outside market hours one
  // side of the book can be empty, and a mid of half the ask is not a price.
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  return { symbol: sym, bid, ask, last, mid };
}

/**
 * Snapshot for a single contract: quote, last trade and the day's bar.
 *
 * Asked for by filtering the underlying's chain down to one expiry, strike and
 * type, which is what the snapshot endpoint supports — there is no
 * fetch-one-contract form.
 */
export async function fetchOptionSnapshot({ token, expiry, strike, optType }, key, secret) {
  const sym = occSymbol(token, expiry, strike, optType);
  if (!sym) return { symbol: null, snapshot: null };
  const qs = new URLSearchParams({
    feed: OPTION_FEED,
    expiration_date: expiry,
    strike_price_gte: String(strike),
    strike_price_lte: String(strike),
    type: optType.toLowerCase() === "call" ? "call" : "put",
  });
  const body = await aFetch(
    `${DATA}/v1beta1/options/snapshots/${encodeURIComponent(String(token).toUpperCase())}?${qs}`,
    key, secret
  );
  const snapshots = body?.snapshots || {};
  // Prefer the exact OCC match; fall back to the sole row when the filter
  // returned one contract under a different root (adjusted options carry a
  // suffixed root such as HOOD1).
  const keys = Object.keys(snapshots);
  const chosen = snapshots[sym] || (keys.length === 1 ? snapshots[keys[0]] : null);
  return { symbol: snapshots[sym] ? sym : keys[0] || sym, snapshot: chosen };
}

/**
 * Everything the option pages read for one contract, in the field names the
 * Deribit branch already returns.
 */
export async function fetchOptionTicker(parts, key, secret) {
  const [{ symbol, snapshot }, underlying] = await Promise.all([
    fetchOptionSnapshot(parts, key, secret),
    fetchUnderlying(parts.token, key, secret).catch(() => null),
  ]);

  const bid = Number(snapshot?.latestQuote?.bp) || 0;
  const ask = Number(snapshot?.latestQuote?.ap) || 0;
  const lastTrade = Number(snapshot?.latestTrade?.p) || 0;
  const dayClose = Number(snapshot?.dailyBar?.c) || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (lastTrade || dayClose);
  // The mark is the mid where there is a two-sided market, and the last print
  // otherwise. Alpaca publishes no mark of its own for options.
  const mark = mid;

  return {
    tick_size: TICK,
    mark_price_raw: mark,
    mark_price_usd: roundTick(mark),
    underlying_price: underlying?.mid || null,
    // The indicative feed carries no greeks, so there is no IV to hand back.
    // Reported as null rather than zero: the entry form leaves its IV field
    // untouched on null, where a zero would overwrite a typed value.
    mark_iv: null,
    best_bid_usd: roundTick(bid),
    best_ask_usd: roundTick(ask),
    best_bid_raw: bid,
    best_ask_raw: ask,
    mid_price_raw: mid,
    mid_price_usd: roundTick(mid),
    // US option premiums are quoted in dollars per share already — there is no
    // coin-denominated premium to convert, which is what is_linear means to
    // the callers.
    is_linear: true,
    last_trade: lastTrade || null,
    day_close: dayClose || null,
    feed: OPTION_FEED,
    instrument: symbol,
  };
}

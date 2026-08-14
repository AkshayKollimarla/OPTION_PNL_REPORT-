import { rpcAuthed, collateral, normalizeToken } from "./deribit-close-helpers.js";

// Shared live-position reader. Used by /api/deribit-positions (to show the
// user what they're about to close) and by /api/deribit-exit-all (to build
// the close job from server-fetched state rather than trusting whatever the
// browser posted, which may be seconds stale by the time Confirm is hit).

// get_positions' "currency" param is the MARGIN/settlement currency, not the
// instrument's base asset — confirmed live: currency=SOL_USDC is rejected
// (invalid currency), currency=SOL returns nothing (SOL itself isn't a
// margin wallet), and currency=USDC is what actually returns SOL_USDC-* /
// XRP_USDC-* positions (they're USDC-margined).
//
// A single strategy can ALSO mix margin types on its own: BTC/ETH options
// are always coin-margined (currency=BTC/ETH), but the futures leg may be
// hedged with either the inverse BTC-PERPETUAL (same coin-margined wallet)
// OR the linear BTC_USDC-PERPETUAL (USDC-margined — a different wallet).
// Querying only the base coin's currency misses that USDC-margined leg
// entirely, so every request checks the base coin AND USDC/USDT, merging
// the results and filtering to this token's own instrument prefixes.
export function baseCoin(token) {
  return normalizeToken(token).replace(/_USDC$|_USDT$/i, "");
}

export function isCoinMargined(instrumentName) {
  return !/_USDC-|_USDT-/i.test(instrumentName);
}

// get_positions' "size" is the position's USD/USDC NOTIONAL value for a
// LINEAR (USDC/USDT-margined) future — NOT the coin quantity. Confirmed live
// on a real 10 SOL position: size=748.192, mark_price=74.8192, and
// 748.192/74.8192 = exactly 10. size_currency holds the actual coin amount,
// which is both what the confirmation UI should show and what the close
// order needs. Inverse futures and options don't have this split.
export function trueSize(p) {
  if (p.kind === "future" && /_USDC-|_USDT-/i.test(p.instrument_name) && p.size_currency != null) {
    return p.size_currency;
  }
  return p.size;
}

// Deribit exposes TWO different unrealized-PnL numbers, and they aren't
// interchangeable — verified against the exchange UI:
//   total_profit_loss    = PnL since ENTRY → Deribit's "PNL" column
//   floating_profit_loss = PnL since the last daily SETTLEMENT → "USPL"
// One perpetual leg simultaneously read total=3.179 and floating=11.733.
// "Since entry" answers "am I up or down on this trade", which is the
// question an exit screen exists to answer.
//
// UNITS: linear instruments report in USDC ≈ USD already. Coin-margined ones
// report in the COIN — a BTC option leg read -0.005067 BTC, which rendered as
// "-$0.01" when the true exposure was about -$319.
export function positionPnlUsd(p) {
  if (p.floating_profit_loss_usd != null) return p.floating_profit_loss_usd;
  const pnl = p.total_profit_loss ?? p.floating_profit_loss;
  if (pnl == null) return null;
  return isCoinMargined(p.instrument_name) && p.index_price ? pnl * p.index_price : pnl;
}

// Coin-margined OPTIONS quote premium in the coin (0.00946 BTC) while their
// entry arrives pre-converted as average_price_usd (771.04); showing both raw
// reads as a total wipeout rather than a modest move. The conversion applies
// to coin-margined OPTIONS ONLY — linear USDC options also carry
// average_price_usd (keying off that alone scaled a $0.35 mark to $25.42),
// and inverse futures already quote in USD (scaling would turn $64,633 into
// billions).
export function markPriceUsd(p) {
  if (p.kind === "option" && isCoinMargined(p.instrument_name) && p.index_price) {
    return p.mark_price * p.index_price;
  }
  return p.mark_price;
}

export async function fetchLivePositions(accountId, token) {
  const coin = baseCoin(token);
  const prefixes = [`${coin}-`, `${coin}_USDC-`, `${coin}_USDT-`];
  const currencies = [...new Set([coin, "USDC", "USDT"])];

  // Each currency query goes through rpcAuthed independently — Deribit
  // allows only one active token per API key, and the background auto-close
  // worker re-authenticates on its own tick, so a token grabbed once and
  // shared across concurrent calls can be invalidated mid-flight.
  const [results, coll] = await Promise.all([
    Promise.allSettled(currencies.map(c => rpcAuthed(accountId, "private/get_positions", { currency: c }))),
    collateral(accountId, token).catch(() => null),
  ]);

  const badIp = results.some(r => r.status === "rejected" && r.reason?.isBadIp);
  const all = results.filter(r => r.status === "fulfilled").flatMap(r => r.value || []);

  const seen = new Set();
  const open = all.filter(p => {
    if (!p.instrument_name || seen.has(p.instrument_name)) return false;
    if (!prefixes.some(pre => p.instrument_name.startsWith(pre))) return false;
    if (Math.abs(p.size) <= 1e-9) return false;
    seen.add(p.instrument_name);
    return true;
  });

  return {
    positions: open.map(p => ({
      instrument_name:      p.instrument_name,
      kind:                 p.kind,
      direction:            p.direction,
      size:                 trueSize(p),
      mark_price:           markPriceUsd(p),
      average_price:        p.average_price_usd ?? p.average_price,
      floating_profit_loss: positionPnlUsd(p),
    })),
    collateral: coll ? coll.total_usd : null,
    badIp,
  };
}

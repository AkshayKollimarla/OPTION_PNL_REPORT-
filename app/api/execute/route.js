import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";

async function deribitRpc(base, method, params, accessToken = null) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const res  = await fetch(`${base}/${method}`, {
    method:  "POST",
    headers,
    body:    JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method,
      params,
    }),
    cache: "no-store",
  });
  const json = await res.json();
  if (json.error) {
    console.error(`[deribitRpc] ${method} error full:`, JSON.stringify(json.error));
    throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)} (code ${json.error.code ?? "?"})`);
  }
  return json.result;
}

async function deribitAuth(api_key, api_secret, testnet) {
  const base   = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const result = await deribitRpc(base, "public/auth", {
    grant_type:    "client_credentials",
    client_id:     api_key.trim(),
    client_secret: api_secret.trim(),
  });
  if (!result?.access_token) throw new Error("Auth error: no access_token in response");
  return result.access_token;
}

// Deribit uses variable tick sizes by price range (tick_size_steps).
// Must pass the price we intend to round so the correct tier is selected.
async function getEffectiveTick(base, instrument, price) {
  try {
    const res  = await fetch(
      `${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    const json = await res.json();
    const info = json.result;
    if (!info) return 0.0001;
    const baseTick = info.tick_size ?? 0.0001;
    const steps    = Array.isArray(info.tick_size_steps) ? info.tick_size_steps : [];
    let tick = baseTick;
    for (const s of steps.sort((a, b) => a.above_price - b.above_price)) {
      if (price >= s.above_price) tick = s.tick_size;
    }
    console.log(`[execute] tick for ${instrument} @ ${price}: base=${baseTick} → effective=${tick}`);
    return tick;
  } catch (e) {
    console.log(`[execute] getEffectiveTick failed for ${instrument}: ${e.message}`);
    return 0.0001;
  }
}

// Round price to nearest tick — floor for buys, ceil for sells, so maker orders never cross the spread
function roundToTick(value, tickSize, direction = "buy") {
  if (!tickSize || tickSize <= 0) return value;
  const fn       = direction === "sell" ? Math.ceil : Math.floor;
  const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return parseFloat((fn(value / tickSize) * tickSize).toFixed(decimals));
}

// bid/ask = best_bid_raw / best_ask_raw from the live order book (0 if unavailable)
async function deribitOrder(accessToken, instrument, amount, direction, price = null, bid = 0, ask = 0, testnet = false) {
  const base   = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const method = direction === "buy" ? "private/buy" : "private/sell";

  let effectivePrice = null;
  if (price != null && price > 0) {
    // Step 1: initial priceSrc from bid/ask
    let priceSrc = price;
    if (direction === "buy")  priceSrc = bid > 0 ? bid : (ask > 0 ? ask : price);
    else                      priceSrc = ask > 0 ? ask : (bid > 0 ? bid : price);

    // Step 2: get the correct tick for this price level (tick_size_steps aware)
    const tick = await getEffectiveTick(base, instrument, priceSrc);

    // Step 3: when book side is empty, offset by 1 effective tick
    if (direction === "buy"  && bid === 0 && ask > 0) priceSrc = ask - tick;
    if (direction === "sell" && ask === 0 && bid > 0) priceSrc = bid + tick;

    effectivePrice = roundToTick(Math.max(priceSrc, tick), tick, direction);
    if (effectivePrice <= 0) effectivePrice = tick;
    console.log(`[execute] ${instrument}: bid=${bid} ask=${ask} src=${priceSrc} tick=${tick} → maker_price=${effectivePrice}`);
  }

  const params = {
    instrument_name: instrument,
    amount:          Math.abs(amount),
    type:            effectivePrice != null && effectivePrice > 0 ? "limit" : "market",
  };
  if (effectivePrice != null && effectivePrice > 0) {
    params.price     = effectivePrice;
    params.post_only = true;
  }
  console.log(`[execute] sending ${method}:`, JSON.stringify(params));
  return deribitRpc(base, method, params, accessToken);
}

// POST /api/execute
// Body: {
//   account_id,
//   option_instrument,  // e.g. "ETH-25OCT24-1700-P"
//   option_qty,         // signed: +ve = buy, -ve = sell
//   future_instrument,  // e.g. "ETH-PERPETUAL"
//   future_qty,         // signed
//   order_type          // "market" | "limit"  (default "market")
// }
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const {
    account_id,
    option_instrument,
    option_qty,
    option_price,    // raw (BTC/ETH denomination) — omit for market
    option_bid,      // best_bid_raw from live ticker
    option_ask,      // best_ask_raw from live ticker
    future_instrument,
    future_qty,
    future_price,    // USD — omit for market
    future_bid,
    future_ask,
  } = body;

  if (!account_id) {
    return NextResponse.json({ error: "account_id is required" }, { status: 400 });
  }

  const [rows] = await pool.query(
    `SELECT exchange, api_key, api_secret, private_key, testnet
     FROM trading_accounts WHERE id = ?`,
    [account_id]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const acct    = rows[0];
  const testnet = !!acct.testnet;
  const exchange = acct.exchange.toLowerCase();

  if (exchange !== "deribit") {
    return NextResponse.json(
      { error: `Exchange '${acct.exchange}' is not yet supported for execution. Only Deribit is supported.` },
      { status: 400 }
    );
  }

  if (!acct.api_key || !acct.api_secret) {
    return NextResponse.json({ error: "Account is missing api_key or api_secret" }, { status: 400 });
  }

  try {
    const accessToken = await deribitAuth(acct.api_key, acct.api_secret, testnet);
    const results     = {};

    if (option_instrument && option_qty != null && Number(option_qty) !== 0) {
      const qty       = Number(option_qty);
      const direction = qty > 0 ? "buy" : "sell";
      const price     = option_price != null && Number(option_price) > 0 ? Number(option_price) : null;
      results.option  = await deribitOrder(accessToken, option_instrument, qty, direction, price, Number(option_bid)||0, Number(option_ask)||0, testnet);
    }

    if (future_instrument && future_qty != null && Number(future_qty) !== 0) {
      const qty        = Number(future_qty);
      const direction  = qty > 0 ? "buy" : "sell";
      const price      = future_price != null && Number(future_price) > 0 ? Number(future_price) : null;
      results.futures  = await deribitOrder(accessToken, future_instrument, qty, direction, price, Number(future_bid)||0, Number(future_ask)||0, testnet);
    }

    if (!results.option && !results.futures) {
      return NextResponse.json({ error: "No valid orders to place (qty = 0 or instruments missing)" }, { status: 400 });
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("[execute route]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

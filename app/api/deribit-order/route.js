import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";

async function deribitRpc(base, method, params, accessToken = null) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const json = await res.json();
  if (json.error) {
    console.error("[deribit-order rpc] full error:", JSON.stringify(json.error));
    throw new Error(`${json.error.message ?? JSON.stringify(json.error)} (code ${json.error.code})`);
  }
  return json.result;
}

async function getAuth(accountId) {
  const [rows] = await pool.query(
    `SELECT api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`,
    [accountId]
  );
  if (!rows.length) throw new Error("Account not found");
  const { api_key, api_secret, testnet } = rows[0];
  if (!api_key || !api_secret) throw new Error("No credentials for this account");
  const base = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const auth = await deribitRpc(base, "public/auth", {
    grant_type: "client_credentials",
    client_id: api_key.trim(),
    client_secret: api_secret.trim(),
  });
  if (!auth?.access_token) throw new Error("Auth failed");
  return { accessToken: auth.access_token, base };
}

function roundToTick(value, tickSize, direction = "buy") {
  if (!tickSize || tickSize <= 0) return value;
  const fn       = direction === "sell" ? Math.ceil : Math.floor;
  const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
  return parseFloat((fn(value / tickSize) * tickSize).toFixed(decimals));
}

async function getInstrumentInfo(base, instrument) {
  try {
    const res  = await fetch(
      `${base}/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
    const json = await res.json();
    return json.result || null;
  } catch { return null; }
}

// Deribit uses variable tick sizes by price range (tick_size_steps).
// e.g. ETH options: tick=0.0001 below 0.005, tick=0.0005 above 0.005.
// Must pass the price we intend to send so the right tick is chosen.
function tickForPrice(info, price) {
  if (!info) return 0.0001;
  const baseTick = info.tick_size ?? 0.0001;
  const steps    = Array.isArray(info.tick_size_steps) ? info.tick_size_steps : [];
  let tick = baseTick;
  for (const s of steps.sort((a, b) => a.above_price - b.above_price)) {
    if (price >= s.above_price) tick = s.tick_size;
  }
  return tick;
}

// POST /api/deribit-order  — place a maker or market order
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { account_id, instrument, qty, direction, price, is_market = false, post_only = true } = body;
  if (!account_id || !instrument || qty == null || !direction) {
    return NextResponse.json({ error: "account_id, instrument, qty, direction required" }, { status: 400 });
  }

  try {
    const { accessToken, base } = await getAuth(account_id);
    const method = direction === "buy" ? "private/buy" : "private/sell";

    const info = await getInstrumentInfo(base, instrument);

    let effectivePrice = null;
    if (!is_market && price != null && price > 0) {
      const tick     = tickForPrice(info, price);
      effectivePrice = roundToTick(price, tick, direction);
      if (effectivePrice <= 0) effectivePrice = tick;
      console.log(`[deribit-order] ${instrument}: raw=${price} tick=${tick} dir=${direction} → price=${effectivePrice}`);
    }

    // Inverse futures (e.g. ETH-PERPETUAL, BTC-PERPETUAL) are quoted in USD
    // notional with a fixed contract size (1 USD for ETH, 10 USD for BTC) —
    // "amount" must be an integer multiple of contract_size, not a coin qty.
    //
    // Options and linear futures take "amount" as a number of CONTRACTS, not
    // raw coin qty. For BTC/ETH, contract_size is 1 (1 contract = 1 BTC/ETH)
    // so this has always been a no-op. But altcoin instruments like
    // SOL_USDC/XRP_USDC use contract_size > 1 (e.g. 1 contract = 10 SOL) —
    // sending the raw coin qty there overshoots the order by that multiple.
    let amount = Math.abs(Number(qty));
    const isInverseFuture = info?.kind === "future" && info?.future_type && info.future_type !== "linear";
    const contractSize = info?.contract_size || 1;
    if (isInverseFuture) {
      let refPrice = effectivePrice;
      if (!refPrice) {
        try {
          const tRes  = await fetch(`${base}/public/ticker?instrument_name=${encodeURIComponent(instrument)}`, { cache: "no-store" });
          const tJson = await tRes.json();
          refPrice = tJson.result?.mark_price || tJson.result?.last_price || tJson.result?.index_price || 0;
        } catch { refPrice = 0; }
      }
      if (refPrice > 0) {
        const rawUsd = amount * refPrice;
        const converted = Math.max(contractSize, Math.round(rawUsd / contractSize) * contractSize);
        console.log(`[deribit-order] inverse future ${instrument}: qty=${amount} @ ref=${refPrice} → amount(USD)=${converted} (contract_size=${contractSize})`);
        amount = converted;
      } else {
        console.warn(`[deribit-order] could not get reference price for ${instrument}, sending raw qty as amount`);
      }
    } else if (contractSize > 1) {
      const contracts = Math.max(1, Math.round(amount / contractSize));
      console.log(`[deribit-order] ${instrument}: coin_qty=${amount}, contract_size=${contractSize} → amount(contracts)=${contracts}`);
      amount = contracts;
    }

    const params = {
      instrument_name: instrument,
      amount,
      type: effectivePrice ? "limit" : "market",
    };
    if (effectivePrice) {
      params.price = effectivePrice;
      if (post_only) params.post_only = true;
    }

    const result = await deribitRpc(base, method, params, accessToken);
    const order = result.order;
    return NextResponse.json({
      ok:           true,
      order_id:     order.order_id,
      amount:       order.amount,
      filled_amount: order.filled_amount,
      order_state:  order.order_state,
      price:        order.price,
    });
  } catch (err) {
    console.error("[deribit-order POST]", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/deribit-order?account_id=X&order_id=Y  — get order state
export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const accountId = sp.get("account_id");
  const orderId   = sp.get("order_id");
  if (!accountId || !orderId) {
    return NextResponse.json({ error: "account_id and order_id required" }, { status: 400 });
  }
  try {
    const { accessToken, base } = await getAuth(accountId);
    const result = await deribitRpc(base, "private/get_order_state", { order_id: orderId }, accessToken);
    return NextResponse.json({
      ok:           true,
      order_id:     result.order_id,
      instrument:   result.instrument_name,
      amount:       result.amount,
      filled_amount: result.filled_amount,
      order_state:  result.order_state,
      price:        result.price,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/deribit-order?account_id=X&order_id=Y  — cancel order
export async function DELETE(request) {
  const sp = new URL(request.url).searchParams;
  const accountId = sp.get("account_id");
  const orderId   = sp.get("order_id");
  if (!accountId || !orderId) {
    return NextResponse.json({ error: "account_id and order_id required" }, { status: 400 });
  }
  try {
    const { accessToken, base } = await getAuth(accountId);
    const result = await deribitRpc(base, "private/cancel", { order_id: orderId }, accessToken);
    return NextResponse.json({
      ok:           true,
      order_id:     result.order_id,
      filled_amount: result.filled_amount,
      order_state:  result.order_state,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

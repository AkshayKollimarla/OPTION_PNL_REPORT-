import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";

async function deribitAuth(api_key, api_secret, testnet) {
  const base = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const url  = `${base}/public/auth?grant_type=client_credentials` +
               `&client_id=${encodeURIComponent(api_key)}` +
               `&client_secret=${encodeURIComponent(api_secret)}`;
  const res  = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  if (json.error) throw new Error(`Auth error: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result.access_token;
}

async function deribitOrder(accessToken, instrument, amount, direction, orderType = "market", testnet = false) {
  const base     = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const endpoint = direction === "buy" ? "/private/buy" : "/private/sell";
  const url      = `${base}${endpoint}` +
                   `?instrument_name=${encodeURIComponent(instrument)}` +
                   `&amount=${Math.abs(amount)}` +
                   `&type=${orderType}` +
                   `&access_token=${encodeURIComponent(accessToken)}`;
  const res  = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  if (json.error) throw new Error(`Order error (${instrument}): ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
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
    future_instrument,
    future_qty,
    order_type = "market",
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
      results.option  = await deribitOrder(accessToken, option_instrument, qty, direction, order_type, testnet);
    }

    if (future_instrument && future_qty != null && Number(future_qty) !== 0) {
      const qty        = Number(future_qty);
      const direction  = qty > 0 ? "buy" : "sell";
      results.futures  = await deribitOrder(accessToken, future_instrument, qty, direction, order_type, testnet);
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

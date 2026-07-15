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
  if (json.error) throw new Error(`${json.error.message ?? JSON.stringify(json.error)} (code ${json.error.code ?? "?"})`);
  return json.result;
}

// Inverse contracts (ETH, BTC) hold collateral in the coin itself. Linear
// USDC-margined contracts (SOL_USDC, XRP_USDC, ...) settle entirely in USDC —
// there is no separate coin wallet on Deribit for those.
function coinLegFor(token) {
  const t = (token || "ETH").toUpperCase();
  if (t.includes("_USDC") || t.includes("_USDT")) return null;
  return t;
}

// GET /api/balance?account_id=1&currency=ETH
//   Returns: { currency, balance, equity, available_funds, margin_balance }
// GET /api/balance?account_id=1&mode=collateral&token=BTC
//   Fetches whichever coin's wallet the strategy's token actually uses (ETH,
//   BTC, or USDC-only for linear SOL_USDC/XRP_USDC contracts) — not
//   hardcoded to ETH.
//   Returns: { coin_symbol, coin_equity, coin_index_price, coin_equity_usd, usdc_equity, total_usd }
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("account_id");
  const currency  = (searchParams.get("currency") || "ETH").toUpperCase();
  const mode      = searchParams.get("mode") || "";
  const collateralToken = searchParams.get("token") || currency;

  if (!accountId) {
    return NextResponse.json({ error: "account_id is required" }, { status: 400 });
  }

  const [rows] = await pool.query(
    `SELECT exchange, api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`,
    [accountId]
  );
  if (!rows.length) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const { api_key, api_secret, testnet } = rows[0];
  const base = testnet ? DERIBIT_TEST : DERIBIT_LIVE;

  if (!api_key || !api_secret) {
    return NextResponse.json({ error: "Account has no API credentials" }, { status: 400 });
  }

  try {
    // Auth
    const authResult = await deribitRpc(base, "public/auth", {
      grant_type:    "client_credentials",
      client_id:     api_key.trim(),
      client_secret: api_secret.trim(),
    });
    const accessToken = authResult?.access_token;
    if (!accessToken) throw new Error("No access_token in auth response");

    // ── Collateral mode: strategy's own coin equity (→ USD) + USDC equity ──
    if (mode === "collateral") {
      const coinSymbol = coinLegFor(collateralToken);

      const [coinRes, usdcRes] = await Promise.allSettled([
        coinSymbol
          ? deribitRpc(base, "private/get_account_summary", { currency: coinSymbol, extended: false }, accessToken)
          : Promise.resolve(null),
        deribitRpc(base, "private/get_account_summary", { currency: "USDC", extended: false }, accessToken),
      ]);

      // Coin index price via public endpoint (no auth needed)
      let coinIndex = 0;
      if (coinSymbol) {
        try {
          const idxRes  = await fetch(`${base}/public/get_index_price?index_name=${coinSymbol.toLowerCase()}_usd`, { headers: { Accept: "application/json" }, cache: "no-store" });
          const idxJson = await idxRes.json();
          coinIndex = idxJson.result?.index_price ?? 0;
        } catch { /* leave at 0 */ }
      }

      const coinEquity = coinSymbol && coinRes.status === "fulfilled" ? (coinRes.value?.equity ?? 0) : 0;
      const usdcEquity = usdcRes.status === "fulfilled" ? (usdcRes.value.equity ?? 0) : 0;
      const coinUsd    = coinEquity * coinIndex;

      console.log(`[balance collateral] ${coinSymbol ?? "USDC-only"} ${coinEquity} @ $${coinIndex} = $${coinUsd.toFixed(2)} | USDC $${usdcEquity.toFixed(2)} | Total $${(coinUsd + usdcEquity).toFixed(2)}`);

      return NextResponse.json({
        coin_symbol:      coinSymbol || "USDC",
        coin_equity:      coinEquity,
        coin_index_price: coinIndex,
        coin_equity_usd:  coinUsd,
        usdc_equity:      usdcEquity,
        total_usd:        coinUsd + usdcEquity,
      });
    }

    // ── Single-currency mode (existing behaviour) ──
    const summary = await deribitRpc(base, "private/get_account_summary", {
      currency,
      extended: false,
    }, accessToken);

    return NextResponse.json({
      currency,
      balance:         summary.balance         ?? 0,
      equity:          summary.equity          ?? 0,
      available_funds: summary.available_funds ?? 0,
      margin_balance:  summary.margin_balance  ?? 0,
    });
  } catch (err) {
    console.error("[balance route]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

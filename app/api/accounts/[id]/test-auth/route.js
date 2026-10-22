import { NextResponse } from "next/server";
import pool from "../../../../../lib/options-db";
import { isAlpacaKey } from "../../../../../lib/alpaca";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";
const ALPACA_PAPER = "https://paper-api.alpaca.markets";
const ALPACA_LIVE = "https://api.alpaca.markets";
const HL_INFO = "https://api.hyperliquid.xyz/info";

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/**
 * Test the credentials against the venue they actually belong to.
 *
 * This used to ask Deribit whatever the account was, so an Alpaca key could
 * only ever come back "invalid_credentials" -- a real failure message about
 * an imaginary problem, for an account that worked perfectly everywhere else
 * in the app.
 *
 * The venue is decided the same way the rest of the app decides it: by the
 * credential. An Alpaca key id is "PK..." on paper and "AK..." on live, a
 * Hyperliquid account is a wallet address, and anything else is Deribit. The
 * exchange column is a reporting label on this book -- HYPER-USMARKETS is
 * labelled hyperliquid and holds Alpaca keys -- so it cannot be the thing
 * that routes.
 */
export async function POST(request, { params }) {
  const { id } = params;

  const [rows] = await pool.query(
    `SELECT name, exchange, api_key, api_secret, private_key, testnet
       FROM trading_accounts WHERE id = ?`, [id]);
  if (!rows.length) {
    return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  const acct = rows[0];
  const key = String(acct.api_key || "").trim();

  try {
    if (isAlpacaKey(key)) return NextResponse.json(await testAlpaca(acct, key));
    if (WALLET.test(key)) return NextResponse.json(await testHyperliquid(acct, key));
    return NextResponse.json(await testDeribit(acct, key));
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Network error: ${err.message}` });
  }
}

async function testAlpaca(acct, key) {
  const live = /^AK/i.test(key);
  const base = live ? ALPACA_LIVE : ALPACA_PAPER;
  if (!acct.api_secret) return { ok: false, error: "No API secret saved for this account." };

  const res = await fetch(`${base}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": acct.api_secret,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      error: `Alpaca rejected the credentials: ${body?.message || `HTTP ${res.status}`}`,
      // The commonest cause by far, and invisible from the key alone.
      hint: `The key id begins ${key.slice(0, 2)}, which is Alpaca's ${live ? "LIVE" : "PAPER"} prefix, so it was tested against ${base}. A paper key cannot authenticate against live, or the reverse.`,
      endpoint: base,
      client_id_preview: `${key.slice(0, 8)}…`,
    };
  }
  return {
    ok: true,
    message: `Authenticated with Alpaca ${live ? "live" : "paper"}.`,
    scope: [
      body?.status ? `account ${body.status}` : null,
      body?.currency && body?.buying_power ? `${Number(body.buying_power).toLocaleString()} ${body.currency} buying power` : null,
    ].filter(Boolean).join(" · "),
    endpoint: base,
  };
}

async function testHyperliquid(acct, address) {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: `Hyperliquid rejected the address: HTTP ${res.status}`, endpoint: HL_INFO };
  }
  const equity = Number(body?.marginSummary?.accountValue);
  return {
    ok: true,
    message: "Hyperliquid answered for this wallet.",
    scope: Number.isFinite(equity) ? `account value ${equity.toLocaleString()}` : "no balance on this wallet",
    // Stated rather than left to be assumed: nothing here proves the secret
    // key is right. Hyperliquid's read endpoints are public, so this confirms
    // the address is well formed and known to the venue, and no more. The
    // secret is only exercised when an order is signed.
    hint: "This checks the address only. Hyperliquid's read API is public, so a wrong secret key would still pass here.",
    endpoint: HL_INFO,
  };
}

async function testDeribit(acct, key) {
  const base = acct.testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  if (!key || !acct.api_secret) {
    return { ok: false, error: "No API key / secret saved for this account." };
  }

  const res = await fetch(`${base}/public/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "public/auth",
      params: { grant_type: "client_credentials", client_id: key, client_secret: acct.api_secret.trim() },
    }),
    cache: "no-store",
  });
  const json = await res.json();

  if (json.error) {
    return {
      ok: false,
      error: `Deribit rejected the credentials: "${json.error.message}" (code ${json.error.code})`,
      hint: acct.testnet
        ? "You are connecting to TEST.deribit.com — make sure these keys are from test.deribit.com."
        : "You are connecting to LIVE deribit.com — make sure these keys are from your live Deribit account, not testnet.",
      endpoint: base,
      client_id_preview: `${key.slice(0, 8)}…`,
    };
  }
  return {
    ok: true,
    message: "Authentication successful!",
    scope: json.result?.scope,
    endpoint: base,
  };
}

import { NextResponse } from "next/server";
import pool from "../../../../../lib/options-db";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";

export async function POST(request, { params }) {
  const { id } = params;

  const [rows] = await pool.query(
    `SELECT exchange, api_key, api_secret, testnet FROM trading_accounts WHERE id = ?`,
    [id]
  );
  if (!rows.length) {
    return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
  }

  const { exchange, api_key, api_secret, testnet } = rows[0];
  const base = testnet ? DERIBIT_TEST : DERIBIT_LIVE;

  if (!api_key || !api_secret) {
    return NextResponse.json({ ok: false, error: "No API key / secret saved for this account." });
  }

  try {
    const res  = await fetch(`${base}/public/auth`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "public/auth",
        params: {
          grant_type:    "client_credentials",
          client_id:     api_key.trim(),
          client_secret: api_secret.trim(),
        },
      }),
      cache: "no-store",
    });
    const json = await res.json();

    if (json.error) {
      return NextResponse.json({
        ok:    false,
        error: `Deribit rejected the credentials: "${json.error.message}" (code ${json.error.code})`,
        hint:  testnet
          ? "You are connecting to TEST.deribit.com — make sure these keys are from test.deribit.com."
          : "You are connecting to LIVE deribit.com — make sure these keys are from your live Deribit account, not testnet.",
        endpoint: base,
        client_id_preview: api_key.trim().slice(0, 8) + "…",
      });
    }

    return NextResponse.json({
      ok:    true,
      message: "Authentication successful!",
      scope: json.result?.scope,
      endpoint: base,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Network error: ${err.message}` });
  }
}

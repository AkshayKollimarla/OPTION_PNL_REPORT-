import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";

export const dynamic = "force-dynamic";

const DERIBIT_LIVE = "https://www.deribit.com/api/v2";
const DERIBIT_TEST = "https://test.deribit.com/api/v2";

async function dFetch(path, testnet = false) {
  const base = testnet ? DERIBIT_TEST : DERIBIT_LIVE;
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

// Parse "YYYY-MM-DD" → Deribit expiry label "25OCT24"
function toDeribitExpiry(dateStr) {
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(dateStr + "T00:00:00Z");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTHS[d.getUTCMonth()];
  const yr  = String(d.getUTCFullYear()).slice(-2);
  return `${day}${mon}${yr}`;
}

// Build Deribit instrument name: ETH-25OCT24-1700-P
export function buildInstrumentName(currency, expiryDate, strike, optType) {
  const exp  = toDeribitExpiry(expiryDate);
  const type = optType.toUpperCase() === "CALL" ? "C" : "P";
  return `${currency.toUpperCase()}-${exp}-${strike}-${type}`;
}

// GET /api/market?account_id=X&token=ETH&action=chain
//   → { expiries: [{ date, strikes: [...] }] }
// GET /api/market?account_id=X&token=ETH&action=futures
//   → { mark_price, index_price, instrument }
// GET /api/market?account_id=X&token=ETH&action=ticker&instrument=ETH-25OCT24-1700-P
//   → { mark_price_usd, mark_price_raw, underlying_price, mark_iv, best_bid_usd, best_ask_usd }

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const accountId  = searchParams.get("account_id");
  const token      = (searchParams.get("token") || "ETH").toUpperCase();
  const action     = searchParams.get("action") || "chain";
  const instrument = searchParams.get("instrument") || "";

  let exchange = "deribit";
  let testnet  = false;

  if (accountId) {
    try {
      const [rows] = await pool.query(
        `SELECT exchange, testnet FROM trading_accounts WHERE id = ?`,
        [accountId]
      );
      if (rows.length) {
        exchange = rows[0].exchange.toLowerCase();
        testnet  = !!rows[0].testnet;
      }
    } catch {
      // table might not exist yet; default to deribit
    }
  }

  try {
    if (exchange === "deribit") {
      if (action === "chain") {
        const instruments = await dFetch(
          `/public/get_instruments?currency=${token}&kind=option&expired=false`,
          testnet
        );

        // Group by expiry date → unique sorted strikes
        const map = {};
        for (const inst of instruments) {
          if (!inst.is_active) continue;
          const dateKey = new Date(inst.expiration_timestamp)
            .toISOString().split("T")[0]; // YYYY-MM-DD
          if (!map[dateKey]) map[dateKey] = new Set();
          map[dateKey].add(inst.strike);
        }

        const expiries = Object.keys(map)
          .sort()
          .map(date => ({
            date,
            label: toDeribitExpiry(date),
            strikes: [...map[date]].sort((a, b) => a - b),
          }));

        return NextResponse.json({ expiries });
      }

      if (action === "futures") {
        const ticker = await dFetch(
          `/public/ticker?instrument_name=${token}-PERPETUAL`,
          testnet
        );
        return NextResponse.json({
          mark_price:  ticker.mark_price,
          index_price: ticker.index_price,
          instrument:  `${token}-PERPETUAL`,
        });
      }

      if (action === "ticker" && instrument) {
        const ticker = await dFetch(
          `/public/ticker?instrument_name=${encodeURIComponent(instrument)}`,
          testnet
        );
        const underlying = ticker.underlying_price ?? ticker.index_price ?? 1;
        const raw        = ticker.mark_price ?? 0;
        return NextResponse.json({
          mark_price_raw:   raw,
          mark_price_usd:   raw * underlying,
          underlying_price: underlying,
          mark_iv:          ticker.mark_iv ?? null,
          best_bid_usd:     (ticker.best_bid_price ?? 0) * underlying,
          best_ask_usd:     (ticker.best_ask_price ?? 0) * underlying,
          instrument,
        });
      }
    }

    return NextResponse.json({ error: `action '${action}' not supported for exchange '${exchange}'` }, { status: 400 });
  } catch (err) {
    console.error("[market route]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

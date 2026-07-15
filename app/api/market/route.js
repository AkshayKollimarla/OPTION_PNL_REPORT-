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
        let instruments = [];
        let chainErr = null;
        // Try direct currency lookup first; fall back to `any` + prefix filter for
        // compound tickers like SOL_USDC that Deribit may not accept as currency.
        try {
          instruments = await dFetch(
            `/public/get_instruments?currency=${token}&kind=option&expired=false`,
            testnet
          );
        } catch (err) {
          chainErr = err.message;
          console.warn(`[market chain] direct currency=${token} failed: ${err.message}. Trying currency=any…`);
        }

        if (!instruments?.length) {
          try {
            const all = await dFetch(
              `/public/get_instruments?currency=any&kind=option&expired=false`,
              testnet
            );
            const prefix = token + "-";
            instruments = (all || []).filter(i => i.instrument_name?.startsWith(prefix));
            if (instruments.length) chainErr = null; // recovered
          } catch (e2) {
            console.error("[market chain] fallback currency=any also failed:", e2.message);
            if (!chainErr) chainErr = e2.message;
          }
        }

        if (!instruments?.length) {
          return NextResponse.json({ expiries: [], error: chainErr || "No instruments found for " + token }, { status: 200 });
        }

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
        // Optional explicit override (e.g. "BTC_USDC-PERPETUAL" for the
        // linear/USDC-margined perpetual) — falls back to the inverse
        // perpetual derived from token, same as before, when not given.
        const futInst = instrument || `${token}-PERPETUAL`;
        const ticker = await dFetch(
          `/public/ticker?instrument_name=${encodeURIComponent(futInst)}`,
          testnet
        );
        const bid = ticker.best_bid_price ?? 0;
        const ask = ticker.best_ask_price ?? 0;
        return NextResponse.json({
          mark_price:  ticker.mark_price,
          index_price: ticker.index_price,
          instrument:  futInst,
          best_bid:    bid,
          best_ask:    ask,
          mid_price:   bid > 0 && ask > 0 ? (bid + ask) / 2 : ticker.mark_price,
        });
      }

      if (action === "ticker" && instrument) {
        const ticker = await dFetch(
          `/public/ticker?instrument_name=${encodeURIComponent(instrument)}`,
          testnet
        );
        const underlying = ticker.underlying_price ?? ticker.index_price ?? 1;
        const raw        = ticker.mark_price ?? 0;
        const bidRaw     = ticker.best_bid_price ?? 0;
        const askRaw     = ticker.best_ask_price ?? 0;
        const midRaw     = bidRaw > 0 && askRaw > 0 ? (bidRaw + askRaw) / 2 : raw;
        // Linear (USDC-settled) instruments like SOL_USDC: mark_price is already in USDC.
        // Inverse (coin-settled) like ETH/BTC: mark_price is in coin, must multiply by underlying.
        const isLinear = token.includes("_USDC") || token.includes("_USDT");
        const toUsd    = isLinear ? 1 : underlying;
        return NextResponse.json({
          mark_price_raw:   raw,
          mark_price_usd:   raw    * toUsd,
          underlying_price: underlying,
          mark_iv:          ticker.mark_iv ?? null,
          best_bid_usd:     bidRaw * toUsd,
          best_ask_usd:     askRaw * toUsd,
          best_bid_raw:     bidRaw,
          best_ask_raw:     askRaw,
          mid_price_raw:    midRaw,
          mid_price_usd:    midRaw * toUsd,
          is_linear:        isLinear,
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

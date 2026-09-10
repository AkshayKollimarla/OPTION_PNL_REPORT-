import { NextResponse } from "next/server";
import pool from "../../../lib/options-db";
import {
  resolveProvider,
  parseInstrument,
  fetchChain as alpacaChain,
  fetchUnderlying as alpacaUnderlying,
  fetchOptionTicker as alpacaTicker,
  searchSymbols as alpacaSearch,
  fetchAssets as alpacaAssets,
} from "../../../lib/alpaca";

// Crypto tokens the Deribit book trades, offered when nothing has been typed.
const DERIBIT_TOKENS = [
  { symbol: "ETH",      name: "Ether" },
  { symbol: "BTC",      name: "Bitcoin" },
  { symbol: "SOL_USDC", name: "Solana (USDC-linear)" },
  { symbol: "XRP_USDC", name: "XRP (USDC-linear)" },
];

// Symbols this account has already traded, newest first.
//
// It is the most useful thing to show before anything is typed: the picker
// opens on the dozen names actually in play rather than an alphabetical slice
// of six thousand tickers.
async function recentTokens(accountId) {
  if (!accountId) return [];
  try {
    const [rows] = await pool.query(
      `SELECT token, MAX(entry_date) AS last_used
         FROM options_trades
        WHERE account_id = ? AND token IS NOT NULL AND token <> ''
        GROUP BY token
        ORDER BY last_used DESC
        LIMIT 60`,
      [accountId]
    );
    return rows.map((r) => String(r.token).toUpperCase());
  } catch {
    return [];
  }
}

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

// Parse "YYYY-MM-DD" → Deribit expiry label "25OCT24". Deribit does NOT
// zero-pad single-digit days (confirmed live: BTC-1AUG26-..., not
// BTC-01AUG26-...) — padding here produces an instrument name that doesn't
// exist on Deribit and public/ticker rejects with HTTP 400.
function toDeribitExpiry(dateStr) {
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(dateStr + "T00:00:00Z");
  const day = String(d.getUTCDate());
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
  // Credentials are read here so the provider can be resolved from the key
  // rather than the exchange label — see lib/alpaca.js for why the two differ
  // on the US-markets account. They never leave the server.
  let apiKey = null;
  let apiSecret = null;

  if (accountId) {
    try {
      const [rows] = await pool.query(
        `SELECT exchange, testnet, api_key, api_secret FROM trading_accounts WHERE id = ?`,
        [accountId]
      );
      if (rows.length) {
        testnet  = !!rows[0].testnet;
        exchange = resolveProvider(rows[0]);
        apiKey    = rows[0].api_key;
        apiSecret = rows[0].api_secret;
      }
    } catch {
      // table might not exist yet; default to deribit
    }
  }

  try {
    if (exchange === "alpaca") {
      if (!apiKey || !apiSecret) {
        return NextResponse.json(
          { error: "This account has no Alpaca API key and secret saved." },
          { status: 400 }
        );
      }

      if (action === "symbols") {
        const q = (searchParams.get("q") || "").trim();
        const [matches, recent] = await Promise.all([
          alpacaSearch(q, apiKey, apiSecret),
          recentTokens(accountId),
        ]);
        // Recent tokens are checked against the live asset list before being
        // offered. That drops names that cannot be priced — legacy labels like
        // HOOD-29THJUNE, and NOKIA, whose US listing is actually NOK — so the
        // picker never suggests a symbol whose chain would come back empty.
        const bySymbol = new Map();
        for (const a of await alpacaAssets(apiKey, apiSecret)) bySymbol.set(a.symbol, a);
        const qUpper = q.toUpperCase();
        const recentHits = recent
          .filter((t) => bySymbol.has(t))
          .filter((t) => !q || t.includes(qUpper) || bySymbol.get(t).name.toUpperCase().includes(qUpper))
          .map((t) => ({ ...bySymbol.get(t), recent: true }));

        const seen = new Set(recentHits.map((r) => r.symbol));
        const rest = matches.filter((a) => !seen.has(a.symbol));
        return NextResponse.json({ symbols: [...recentHits, ...rest].slice(0, 60) });
      }

      if (action === "chain") {
        // A symbol Alpaca does not list is an ordinary outcome, not a server
        // fault: switching an account from Deribit to the US book leaves a
        // token like XRP_USDC in the form, and Alpaca answers 422. Reported as
        // an empty chain with a reason, the same shape the Deribit branch
        // returns, so the page can say why nothing loaded instead of throwing
        // a 500 and showing blank dropdowns.
        let expiries = [];
        try {
          expiries = await alpacaChain(token, apiKey, apiSecret);
        } catch (err) {
          const unknown = /invalid underlying|not found|422/i.test(err.message);
          return NextResponse.json(
            {
              expiries: [],
              error: unknown
                ? `${token} is not a US-listed symbol on this account.`
                : err.message,
            },
            { status: 200 }
          );
        }
        if (!expiries.length) {
          return NextResponse.json(
            { expiries: [], error: `${token} has no listed options.` },
            { status: 200 }
          );
        }
        return NextResponse.json({ expiries });
      }

      if (action === "futures") {
        // A US-equity strategy has no futures leg. The instrument the caller
        // composed (TOKEN-PERPETUAL) has no meaning here, so it is ignored and
        // the underlying share price answers instead — which is what
        // fut_entry_price holds for these strategies.
        const u = await alpacaUnderlying(token, apiKey, apiSecret).catch(() => null);
        if (!u || !u.mid) {
          return NextResponse.json(
            { error: `No quote available for ${token}.` },
            { status: 200 }
          );
        }
        return NextResponse.json({
          mark_price:  u.mid,
          index_price: u.last || u.mid,
          instrument:  u.symbol,
          best_bid:    u.bid,
          best_ask:    u.ask,
          mid_price:   u.mid,
        });
      }

      if (action === "ticker" && instrument) {
        const parts = parseInstrument(instrument);
        if (!parts) {
          return NextResponse.json(
            { error: `Could not read an option from '${instrument}'.` },
            { status: 400 }
          );
        }
        const data = await alpacaTicker(parts, apiKey, apiSecret);
        if (!data.mark_price_usd) {
          return NextResponse.json(
            { error: `No quote for ${data.instrument}. It may not be listed, or the market is closed with no resting bid or offer.`, ...data },
            { status: 200 }
          );
        }
        return NextResponse.json(data);
      }
    }

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
        // get_instrument comes along for the tick size. Deribit prices only
        // exist on the instrument's tick grid, so a raw mark like 1.5488 is
        // not a price anyone can actually trade — it should read 1.5. The
        // tick is per-instrument and price-dependent, never a fixed number of
        // decimals: SOL_USDC options tick at 0.1, while HYPE_USDC options
        // tick at 0.002 and only widen to 0.01 above $0.50. Rounding
        // everything to one decimal would quietly corrupt the latter.
        const [ticker, info] = await Promise.all([
          dFetch(`/public/ticker?instrument_name=${encodeURIComponent(instrument)}`, testnet),
          dFetch(`/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`, testnet).catch(() => null),
        ]);
        const underlying = ticker.underlying_price ?? ticker.index_price ?? 1;
        const raw        = ticker.mark_price ?? 0;
        const bidRaw     = ticker.best_bid_price ?? 0;
        const askRaw     = ticker.best_ask_price ?? 0;
        const midRaw     = bidRaw > 0 && askRaw > 0 ? (bidRaw + askRaw) / 2 : raw;
        // Linear (USDC-settled) instruments like SOL_USDC: mark_price is already in USDC.
        // Inverse (coin-settled) like ETH/BTC: mark_price is in coin, must multiply by underlying.
        //
        // Decided from the INSTRUMENT name, not the strategy's token. A saved
        // token is a label that need not carry the settlement suffix its
        // instruments do — HFT2's strategy is stored as "HYPE" while it trades
        // HYPE_USDC-* options. Keying off the token classified those as
        // coin-margined and multiplied an already-USD premium by the
        // underlying, displaying a $7.07 option as $388.40.
        const isLinear = /_USDC-|_USDT-/i.test(instrument);
        const toUsd    = isLinear ? 1 : underlying;

        // Resolve the tick that applies at THIS price. tick_size_steps lists
        // the wider ticks that kick in above given price levels; the base
        // tick_size applies below all of them.
        const baseTick = info?.tick_size ?? 0;
        const steps    = Array.isArray(info?.tick_size_steps) ? [...info.tick_size_steps] : [];
        let tick = baseTick;
        for (const s of steps.sort((a, b) => a.above_price - b.above_price)) {
          if (raw >= s.above_price) tick = s.tick_size;
        }
        // Only meaningful for linear instruments, where the quote currency IS
        // USD. On coin-margined options the tick governs the COIN-denominated
        // premium, so it cannot be applied to the converted USD figure.
        const roundToTick = (v) => {
          if (!isLinear || !tick || tick <= 0) return v;
          const dec = Math.max(0, -Math.floor(Math.log10(tick)));
          return parseFloat((Math.round(v / tick) * tick).toFixed(dec));
        };

        return NextResponse.json({
          tick_size:        tick || null,
          mark_price_raw:   raw,
          mark_price_usd:   roundToTick(raw * toUsd),
          underlying_price: underlying,
          mark_iv:          ticker.mark_iv ?? null,
          best_bid_usd:     roundToTick(bidRaw * toUsd),
          best_ask_usd:     roundToTick(askRaw * toUsd),
          best_bid_raw:     bidRaw,
          best_ask_raw:     askRaw,
          // NOT rounded: mid_price_raw drives order placement in the entry
          // engine, and /api/deribit-order already snaps the price to tick
          // (with the correct buy/sell direction) right before submitting.
          // Pre-rounding here would round twice, and to nearest rather than
          // in the direction that keeps the order a maker.
          mid_price_raw:    midRaw,
          mid_price_usd:    roundToTick(midRaw * toUsd),
          is_linear:        isLinear,
          instrument,
        });
      }
    }

    if (action === "symbols") {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const recent = await recentTokens(accountId);
      const known = new Map(DERIBIT_TOKENS.map((t) => [t.symbol, t]));
      const out = [];
      // Historical tokens carry a dated suffix — ETH-7THJULY, SOL-HDR-29THJUNE2026
      // — which names a strategy, not a tradable instrument. Reduced to the
      // coin so the picker offers ETH and SOL_USDC rather than a year of old
      // labels; SOL is spelled SOL_USDC on the current book.
      const seenBase = new Set();
      for (const t of recent) {
        let base = t.split("-")[0];
        if (base === "SOL") base = "SOL_USDC";
        if (!base || seenBase.has(base)) continue;
        seenBase.add(base);
        out.push({ symbol: base, name: known.get(base)?.name || "", recent: true });
        known.delete(base);
      }
      for (const t of known.values()) out.push({ ...t, recent: false });
      return NextResponse.json({
        symbols: out.filter((x) => !q || x.symbol.includes(q) || x.name.toUpperCase().includes(q)),
      });
    }

    return NextResponse.json({ error: `action '${action}' not supported for exchange '${exchange}'` }, { status: 400 });
  } catch (err) {
    console.error("[market route]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

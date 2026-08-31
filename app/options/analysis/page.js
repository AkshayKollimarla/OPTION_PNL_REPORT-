"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import PayoffChart from "../../../components/PayoffChart";

/* ── Formatters ─────────────────────────────────────────── */
function pad(n) { return String(n).padStart(2, "0"); }

// Local YYYY-MM-DD from a JS Date — avoids UTC shift on toISOString (IST bug fix)
function localIso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Robustly extract a YYYY-MM-DD in LOCAL time from any date value.
// Handles: "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DDTHH:MM:SS.sssZ" (UTC ISO).
// When the DB pool lacks dateStrings:true, mysql2 serialises DATE as UTC ISO like
// "2026-06-23T18:30:00.000Z" (IST midnight June 24 → UTC June 23). new Date() + localIso
// converts that UTC instant back to the correct local day (June 24).
function toLocalDateStr(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // already YYYY-MM-DD
  const dt = new Date(s.replace(" ", "T"));               // handles both space and T separator
  if (isNaN(dt)) return null;
  return localIso(dt);                                    // convert UTC instant → local date
}

// Display as DD-MM-YYYY
function fmt(d) {
  if (!d) return "—";
  const local = toLocalDateStr(d);
  if (!local) return "—";
  const [y, m, day] = local.split("-");
  return `${day}-${m}-${y}`;
}


function fmtCcy(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtNum(v, dec = 2) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  return n.toFixed(dec);
}

function fmtVol(v) {
  const n = Number(v);
  if (isNaN(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}


function baseToken(token) { return token ? token.split("-")[0] : "—"; }

// Deribit SOL appears under two spellings in the options book: the current
// SOL_USDC, and older SOL-HFT1-/SOL-HDR- rows that reduce to a bare SOL. Same
// instrument, so they collapse to one label — otherwise the Deribit symbol
// list offers SOL and SOL_USDC as if they were different markets, and picking
// either shows half the history.
function canonToken(token) {
  const base = baseToken(token);
  return base === "SOL" ? "SOL_USDC" : base;
}

// bot_entries spells the same instrument SOL-USDC-PERPETUAL, and the report
// matches it by prefix, so the canonical label is translated on the way out.
function botSymbolPrefix(sym) {
  return sym === "SOL_USDC" ? "SOL-USDC" : sym;
}

/* ── Options input fields to display ───────────────────── */

/* ── Bot param fields to display for best-day entry ──── */


/* ── Page ────────────────────────────────────────────────── */
export default function OptionsAnalysis() {
  const [allTrades,       setAllTrades]       = useState([]);
  const [loadingList,     setLoadingList]     = useState(true);
  const [error,           setError]           = useState(null);

  // Cumulative report
  const [cumFrom,    setCumFrom]    = useState("");
  const [cumTo,      setCumTo]      = useState("");
  const [cumSymbol,  setCumSymbol]  = useState("all");
  const [cumAccount, setCumAccount] = useState("all");
  const [cumExchange, setCumExchange] = useState("all");
  // Exchange metadata for the bot side. The cumulative report reads
  // bot_entries, so its exchange / symbol / account universe has to come from
  // there rather than from the options book.
  const [botMeta, setBotMeta] = useState({ exchanges: [], symbolExchange: {}, accountExchange: {} });
  const [accountExchangeById, setAccountExchangeById] = useState({});
  const [cumBot,     setCumBot]     = useState(null);
  const [cumOpts,    setCumOpts]    = useState([]);
  const [loadingCum, setLoadingCum] = useState(false);

  const [accounts,        setAccounts]        = useState([]);

  useEffect(() => {
    fetch("/api/options/trades?limit=9999")
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setAllTrades(j.trades || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    fetch("/api/bot-period-summary")
      .then((r) => r.json())
      .then((j) => setAccounts(j.accounts || []))
      .catch(() => {});
  }, []);

  // id -> exchange for the options accounts. A linked account states its venue
  // outright, which is the only way symbols the grid bot never traded (CRWV,
  // INTC, BE...) can be placed at all — they have no bot_entries row to infer
  // from.
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((j) => {
        const m = {};
        for (const a of j.accounts || []) m[a.id] = String(a.exchange || "").toUpperCase();
        setAccountExchangeById(m);
      })
      .catch(() => {});
  }, []);

  // limit=1 because only the metadata lists are wanted here; the endpoint
  // builds those from the whole table regardless of the row limit.
  useEffect(() => {
    fetch("/api/entries?limit=1", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setBotMeta({
        exchanges: j.exchanges || [],
        symbolExchange: j.symbolExchange || {},
        accountExchange: j.accountExchange || {},
      }))
      .catch(() => {});
  }, []);


  // Base symbols only — ETH, BTC, SOL_USDC — with the two SOL spellings
  // already collapsed into one entry.
  const symbols = useMemo(() => {
    const s = new Set(allTrades.map((t) => canonToken(t.token)).filter(Boolean));
    return [...s].sort();
  }, [allTrades]);

  // Which exchange a base token belongs to, derived from the bot's own
  // symbols: BTC-PERPETUAL -> BTC -> DERIBIT, HYPE-USDC -> HYPE -> HYPERLIQUID.
  // Underscores are normalised first so the options book's SOL_USDC lands on
  // the same base as the bot's SOL-USDC-PERPETUAL.
  const tokenExchange = useMemo(() => {
    const m = {};
    Object.entries(botMeta.symbolExchange).forEach(([sym, ex]) => {
      m[baseToken(String(sym).split("_").join("-"))] = ex;
    });
    return m;
  }, [botMeta.symbolExchange]);

  const exchangeOf = (base) => tokenExchange[baseToken(String(base).split("_").join("-"))];

  // Venue of a whole trade row. The linked account is authoritative; the token
  // is consulted only for rows that predate account linking.
  const tradeExchange = (t) =>
    (t.account_id != null && accountExchangeById[t.account_id]) || exchangeOf(t.token);

  // With no exchange chosen the list is unchanged. With one chosen it shows
  // only that exchange's symbols. Tokens the bot has never traded (equity
  // options with no bot_entries rows) have no exchange and drop out, which is
  // correct: this report is built on bot_entries.
  // Symbols actually held at the chosen venue. Derived from the trades rather
  // than from the token map alone, so equity symbols that only have a venue by
  // way of their account still appear.
  const cumSymbols = useMemo(() => {
    if (cumExchange === "all") return symbols;
    const here = new Set(
      allTrades.filter((t) => tradeExchange(t) === cumExchange).map((t) => canonToken(t.token))
    );
    return symbols.filter((sym) => here.has(sym));
  }, [symbols, cumExchange, tokenExchange, accountExchangeById, allTrades]);
  const cumAccounts = useMemo(
    () => (cumExchange === "all"
      ? accounts
      : accounts.filter((a) => botMeta.accountExchange[a.token_name] === cumExchange)),
    [accounts, cumExchange, botMeta.accountExchange]
  );

  function loadCumulative() {
    setLoadingCum(true);
    setCumBot(null);
    // Either bound may be omitted: no dates at all means the full history,
    // one date means open-ended on that side.
    const p = new URLSearchParams();
    if (cumFrom) p.set("date_from", cumFrom);
    if (cumTo)   p.set("date_to",   cumTo);
    if (cumAccount !== "all") p.set("account", cumAccount);
    if (cumSymbol  !== "all") p.set("symbol",  botSymbolPrefix(cumSymbol));
    if (cumExchange !== "all") p.set("exchange", cumExchange);
    fetch(`/api/cumulative-report?${p}`)
      .then((r) => r.json())
      .then((j) => { if (j.error) throw new Error(j.error); setCumBot(j); })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingCum(false));
    // Options: filter allTrades client-side
    const opts = allTrades.filter((t) => {
      const d = t.entry_date ? toLocalDateStr(t.entry_date) : null;
      if (!d || d === "0000-00-00") return false;
      if (cumFrom && d < cumFrom) return false;
      if (cumTo   && d > cumTo)   return false;
      if (cumSymbol !== "all" && canonToken(t.token) !== cumSymbol) return false;
      // Keep the options half on the same exchange as the bot half, or
      // Combined PNL would add a Deribit-only bot total to an all-venue
      // options total.
      if (cumExchange !== "all" && tradeExchange(t) !== cumExchange) return false;
      return true;
    });
    setCumOpts(opts);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white px-6">
        <div className="flex h-16 items-center justify-between">
          <h1 className="text-lg font-bold text-slate-800">Options &amp; RTPS Analysis</h1>
          <Link href="/options" className="text-sm text-slate-500 hover:text-slate-700">← All Strategies</Link>
        </div>
      </header>

      <div className="p-6 space-y-5">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-5">
            {/* Filters + date range */}
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
              <h2 className="text-sm font-bold text-slate-700 mb-4">Select Date Range &amp; Filters</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Exchange</label>
                  <select value={cumExchange}
                    onChange={(e) => {
                      const next = e.target.value;
                      setCumExchange(next);
                      // Drop a symbol or account belonging to another exchange,
                      // otherwise the filters contradict and the report returns
                      // empty with nothing on screen to explain why.
                      if (next !== "all") {
                        if (cumSymbol !== "all" && exchangeOf(cumSymbol) !== next) setCumSymbol("all");
                        if (cumAccount !== "all" && botMeta.accountExchange[cumAccount] !== next) setCumAccount("all");
                      }
                    }}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                    <option value="all">All Exchanges</option>
                    {botMeta.exchanges.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Symbol</label>
                  <select value={cumSymbol} onChange={(e) => setCumSymbol(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                    <option value="all">All Symbols</option>
                    {cumSymbols.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">Account</label>
                  <select value={cumAccount} onChange={(e) => setCumAccount(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none">
                    <option value="all">All Accounts</option>
                    {cumAccounts.map((a) => <option key={a.token_name} value={a.token_name}>{a.token_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">From</label>
                  <input type="date" value={cumFrom} onChange={(e) => setCumFrom(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-500 uppercase tracking-wide">To</label>
                  <input type="date" value={cumTo} onChange={(e) => setCumTo(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
                </div>
                <div className="flex items-end">
                  <button onClick={loadCumulative} disabled={loadingCum}
                    className="w-full rounded-lg bg-teal-600 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
                    {loadingCum ? "Loading…" : (cumFrom || cumTo) ? "Load Report" : "Load All Data"}
                  </button>
                </div>
              </div>
            </div>

            {/* Results */}
            {cumBot && (() => {
              // Aggregate options PNL by base token.
              //
              // A combined structure is ONE strategy spread over several rows
              // that share a group_id — a 4-leg iron condor is one position,
              // not four. Counting rows made a token look four times as busy
              // as it was. P&L still sums across every leg, because the
              // structure's result is the sum of its legs; only the count and
              // the investment collapse to the group.
              const optByToken = {};
              const seenGroups = new Set();
              cumOpts.forEach((t) => {
                const sym = canonToken(t.token);
                if (!optByToken[sym]) {
                  optByToken[sym] = { pnl: 0, strategies: 0, invSum: 0, invCount: 0 };
                }
                const b = optByToken[sym];
                b.pnl += Number(t.net_booked_pnl || 0);

                // A row with no group_id is a standalone one-leg strategy and
                // always counts. A grouped row counts only the first time its
                // group is seen.
                const gid = t.group_id == null ? null : String(t.group_id);
                const isNewStrategy = gid === null || !seenGroups.has(gid);
                if (gid !== null) seenGroups.add(gid);
                if (isNewStrategy) {
                  b.strategies += 1;
                  // Capital behind the strategy. Every leg of a group carries
                  // the same figure, so it is taken once per strategy — adding
                  // it per leg would inflate a 4-leg structure fourfold.
                  const inv = Number(t.investment);
                  if (Number.isFinite(inv) && inv > 0) {
                    b.invSum += inv;
                    b.invCount += 1;
                  }
                }
              });

              // Investment is the capital standing behind the token, so it
              // averages across that token's strategies rather than summing:
              // the same account balance is redeployed trade after trade, and
              // adding it up would report the balance many times over.
              Object.values(optByToken).forEach((b) => {
                b.investment = b.invCount ? b.invSum / b.invCount : null;
              });

              const totalOptPnl = Object.values(optByToken).reduce((a, b) => a + b.pnl, 0);
              const totalStrategies = Object.values(optByToken).reduce((a, b) => a + b.strategies, 0);

              return (
                <>
                  {/* Summary banner */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <SummaryCard label="Bot Net PNL" value={fmtCcy(cumBot.totals.net_pnl)} colored />
                    <SummaryCard label="Options PNL" value={fmtCcy(totalOptPnl)} colored />
                    <SummaryCard label="Combined PNL" value={fmtCcy(cumBot.totals.net_pnl + totalOptPnl)} colored big />
                    <SummaryCard label="Bot RTP PNL" value={fmtCcy(cumBot.totals.rtp_pnl)} />
                  </div>

                  {/* Per-account bot table */}
                  <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
                    <h3 className="text-sm font-bold text-slate-700 mb-4">
                      Bot Performance by Account
                      <span className="ml-2 text-xs font-normal text-slate-400">{fmt(cumFrom)} → {fmt(cumTo)}</span>
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200">
                            {["Account","Symbol","RTPS","Net PNL","RTP PNL","Rebates","Flatten","Volume","Days"].map((h) => (
                              <th key={h} className={`py-2 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap ${h === "Account" || h === "Symbol" ? "text-left" : "text-right"}`}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {cumBot.rows.map((r) => (
                            <tr key={r.token_name} className="border-b border-dashed border-slate-100 last:border-0 hover:bg-slate-50/60">
                              <td className="py-2.5 px-3 text-sm font-semibold text-teal-700 whitespace-nowrap">{r.token_name}</td>
                              <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">{r.token_symbol}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtNum(r.rtps)}</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-bold whitespace-nowrap ${Number(r.net_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(r.net_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(r.rtp_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtCcy(r.rebates)}</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-semibold whitespace-nowrap ${Number(r.flatten_pnl) >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(r.flatten_pnl)}</td>
                              <td className="py-2.5 px-3 text-right text-sm font-semibold text-slate-700 whitespace-nowrap">{fmtVol(r.volume)}</td>
                              <td className="py-2.5 px-3 text-right text-sm text-slate-500 whitespace-nowrap">{r.active_days}</td>
                            </tr>
                          ))}
                          {/* Totals row */}
                          <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                            <td className="py-2.5 px-3 text-sm text-slate-700" colSpan={2}>TOTAL</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-500">—</td>
                            <td className={`py-2.5 px-3 text-right text-sm font-bold ${cumBot.totals.net_pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(cumBot.totals.net_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtCcy(cumBot.totals.rtp_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtCcy(cumBot.totals.rebates)}</td>
                            <td className={`py-2.5 px-3 text-right text-sm font-bold ${cumBot.totals.flatten_pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(cumBot.totals.flatten_pnl)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-700">{fmtVol(cumBot.totals.volume)}</td>
                            <td className="py-2.5 px-3 text-right text-sm text-slate-500">—</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Options PNL by token */}
                  {cumOpts.length > 0 && (
                    <div className="rounded-xl border border-teal-100 bg-white p-5 shadow-card">
                      <h3 className="text-sm font-bold text-slate-700 mb-4">
                        Options PNL by Token
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          {totalStrategies} strateg{totalStrategies === 1 ? "y" : "ies"}
                          <span className="ml-1">({cumOpts.length} legs)</span>
                        </span>
                      </h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                            <tr className="border-b border-slate-200">
                              {["Token","Strategies","Investment","Net Booked PNL"].map((h) => (
                                <th key={h} className={`py-2 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wide whitespace-nowrap ${h === "Token" ? "text-left" : "text-right"}`}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(optByToken).sort((a, b) => b[1].pnl - a[1].pnl).map(([sym, b]) => (
                              <tr key={sym} className="border-b border-dashed border-slate-100 last:border-0 hover:bg-slate-50/60">
                                <td className="py-2.5 px-3 text-sm font-semibold text-teal-700">{sym}</td>
                                <td className="py-2.5 px-3 text-right text-sm text-slate-600">{b.strategies}</td>
                                <td className="py-2.5 px-3 text-right text-sm text-slate-600">
                                  {b.investment != null ? fmtCcy(b.investment) : "—"}
                                </td>
                                <td className={`py-2.5 px-3 text-right text-sm font-bold ${b.pnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(b.pnl)}</td>
                              </tr>
                            ))}
                            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                              <td className="py-2.5 px-3 text-sm text-slate-700" colSpan={3}>TOTAL</td>
                              <td className={`py-2.5 px-3 text-right text-sm font-bold ${totalOptPnl >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtCcy(totalOptPnl)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
        </div>

      </div>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────── */







function SummaryCard({ label, value, colored, big }) {
  const isNeg = colored && typeof value === "string" && value.startsWith("-");
  const valCls = colored ? (isNeg ? "text-red-600" : "text-emerald-600") : "text-slate-800";
  return (
    <div className={`rounded-xl border bg-white p-4 shadow-card ${big ? "border-teal-200" : "border-slate-100"}`}>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`font-extrabold ${big ? "text-2xl" : "text-xl"} ${valCls}`}>{value}</p>
    </div>
  );
}


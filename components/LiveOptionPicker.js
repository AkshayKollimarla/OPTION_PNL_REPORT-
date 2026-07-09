"use client";

import { useState, useEffect, useCallback } from "react";

// Builds Deribit-style instrument name: ETH-25OCT24-1700-P
function buildName(token, expiryDate, strike, optType) {
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d   = new Date(expiryDate + "T00:00:00Z");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTHS[d.getUTCMonth()];
  const yr  = String(d.getUTCFullYear()).slice(-2);
  const t   = optType.toUpperCase() === "CALL" ? "C" : "P";
  return `${token.toUpperCase()}-${day}${mon}${yr}-${strike}-${t}`;
}

// onFill({ expiry, strike, option_type, opt_entry_price, iv, fut_entry_price, instrument_name, future_instrument })
export default function LiveOptionPicker({ accountId, token, optionType = "PUT", onFill }) {
  const [expiries, setExpiries]       = useState([]); // [{ date, label, strikes[] }]
  const [expiry, setExpiry]           = useState("");
  const [strike, setStrike]           = useState("");
  const [optType, setOptType]         = useState(optionType);
  const [loading, setLoading]         = useState(false);
  const [fetching, setFetching]       = useState(false);
  const [error, setError]             = useState("");
  const [ticker, setTicker]           = useState(null);
  const [futPrice, setFutPrice]       = useState(null);

  const currency = (token || "ETH").toUpperCase();

  // Load option chain when accountId or token changes
  const loadChain = useCallback(async () => {
    if (!accountId || !currency) return;
    setLoading(true);
    setError("");
    setExpiries([]);
    setExpiry("");
    setStrike("");
    setTicker(null);
    try {
      const res  = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=chain`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setExpiries(data.expiries || []);
      if (data.expiries?.length) setExpiry(data.expiries[0].date);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [accountId, currency]);

  useEffect(() => { loadChain(); }, [loadChain]);

  // Current expiry object
  const expiryObj = expiries.find(e => e.date === expiry) || null;
  const strikes   = expiryObj?.strikes || [];

  // When expiry changes reset strike
  useEffect(() => {
    setStrike("");
    setTicker(null);
  }, [expiry]);

  // Fetch futures price
  useEffect(() => {
    if (!accountId || !currency) return;
    fetch(`/api/market?account_id=${accountId}&token=${currency}&action=futures`)
      .then(r => r.json())
      .then(d => { if (d.mark_price) setFutPrice(d.mark_price); })
      .catch(() => {});
  }, [accountId, currency]);

  // Fetch option ticker when strike/type/expiry are set
  async function fetchTicker(currentStrike, currentOptType, currentExpiry) {
    if (!currentStrike || !currentExpiry) return;
    const inst = buildName(currency, currentExpiry, currentStrike, currentOptType);
    setFetching(true);
    setError("");
    try {
      const res  = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=ticker&instrument=${encodeURIComponent(inst)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ticker fetch failed");
      setTicker({ ...data, instrument: inst });
    } catch (e) {
      setError(e.message);
      setTicker(null);
    } finally {
      setFetching(false);
    }
  }

  function handleStrikeChange(e) {
    const s = e.target.value;
    setStrike(s);
    if (s) fetchTicker(s, optType, expiry);
  }

  function handleOptTypeChange(e) {
    const t = e.target.value;
    setOptType(t);
    if (strike) fetchTicker(strike, t, expiry);
  }

  function handleExpiryChange(e) {
    const d = e.target.value;
    setExpiry(d);
    setStrike("");
    setTicker(null);
  }

  function handleApply() {
    if (!ticker || !expiry || !strike) return;
    const instrument      = buildName(currency, expiry, strike, optType);
    const futInstrument   = `${currency}-PERPETUAL`;
    onFill?.({
      expiry,
      strike:            String(strike),
      option_type:       optType,
      opt_entry_price:   ticker.mark_price_usd?.toFixed(2) ?? "",
      iv:                ticker.mark_iv != null ? String(Math.round(ticker.mark_iv)) : "",
      fut_entry_price:   futPrice != null ? String(futPrice) : "",
      instrument_name:   instrument,
      future_instrument: futInstrument,
    });
  }

  const fmt = v => v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
  const canApply = !fetching && ticker && strike && expiry;

  return (
    <div className="rounded-2xl border border-indigo-500/30 bg-indigo-950/30 p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-indigo-300">Live Market Data</span>
          <span className="rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-400 font-medium">
            {currency}
          </span>
        </div>
        <button
          onClick={loadChain}
          disabled={loading}
          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-40"
        >
          {loading ? "Loading…" : "↺ Refresh"}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-slate-400 animate-pulse">Fetching option chain…</p>
      ) : expiries.length === 0 ? (
        <p className="text-sm text-slate-500">
          {accountId ? "No option chain found. Check account and token." : "Select an account to load live data."}
        </p>
      ) : (
        <>
          {/* Pickers Row */}
          <div className="grid grid-cols-3 gap-3">
            {/* Expiry */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Expiry</label>
              <select
                value={expiry}
                onChange={handleExpiryChange}
                className="rounded-lg border border-white/10 bg-[#1e2740] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {expiries.map(e => (
                  <option key={e.date} value={e.date}>{e.label} ({e.date})</option>
                ))}
              </select>
            </div>

            {/* Strike */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Strike ({strikes.length})
              </label>
              <select
                value={strike}
                onChange={handleStrikeChange}
                disabled={strikes.length === 0}
                className="rounded-lg border border-white/10 bg-[#1e2740] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-40"
              >
                <option value="">— Select —</option>
                {strikes.map(s => (
                  <option key={s} value={s}>{s.toLocaleString()}</option>
                ))}
              </select>
            </div>

            {/* Option Type */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Type</label>
              <select
                value={optType}
                onChange={handleOptTypeChange}
                className="rounded-lg border border-white/10 bg-[#1e2740] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="PUT">PUT</option>
                <option value="CALL">CALL</option>
              </select>
            </div>
          </div>

          {/* Ticker Data */}
          {fetching && (
            <p className="text-xs text-slate-400 animate-pulse">Fetching mark price…</p>
          )}

          {ticker && !fetching && (
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                {ticker.instrument}
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Mark Price (USD)</span>
                  <span className="font-semibold text-white">${fmt(ticker.mark_price_usd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Mark IV</span>
                  <span className="font-semibold text-indigo-300">
                    {ticker.mark_iv != null ? `${ticker.mark_iv.toFixed(1)}%` : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Underlying</span>
                  <span className="font-semibold text-white">${fmt(ticker.underlying_price)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Futures (Perp)</span>
                  <span className="font-semibold text-white">
                    {futPrice != null ? `$${fmt(futPrice)}` : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Best Bid</span>
                  <span className="text-slate-300">${fmt(ticker.best_bid_usd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Best Ask</span>
                  <span className="text-slate-300">${fmt(ticker.best_ask_usd)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Apply Button */}
          <button
            onClick={handleApply}
            disabled={!canApply}
            className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ↙ Apply to Form (Strike, Entry Price, IV, Expiry, Futures Price)
          </button>
        </>
      )}
    </div>
  );
}

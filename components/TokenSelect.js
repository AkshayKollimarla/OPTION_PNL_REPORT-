"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Symbol picker for the option entry pages.
//
// It replaces a hard-coded list of four crypto tokens. That list was fine while
// every account traded ETH/BTC/SOL/XRP, but the US-markets account trades some
// six thousand optionable tickers, and reaching one of them meant finding an
// "Other (type manually)…" entry buried at the bottom of a dropdown that
// otherwise offered nothing relevant.
//
// The options come from the server per account, so Deribit accounts still see
// their four coins and the Alpaca account sees the US universe — searched
// live, with the symbols it already trades listed first.
//
// Free text is always accepted. A symbol the venue does not list should be
// awkward, not impossible: historical strategies carry labels like
// HOOD-29THJUNE that no longer resolve to anything tradable, and they still
// need to be editable.
export default function TokenSelect({ accountId, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const timerRef = useRef(null);

  // Close on an outside click or Escape — a panel that can only be dismissed by
  // choosing something is a trap.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Search server-side, debounced. The asset list is thousands of rows, so it
  // is filtered where it lives rather than shipped to the browser.
  useEffect(() => {
    if (!open) return;
    clearTimeout(timerRef.current);
    let cancelled = false;
    setLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ action: "symbols", q: query.trim() });
        if (accountId) qs.set("account_id", String(accountId));
        const res = await fetch(`/api/market?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        setSymbols(data.symbols || []);
        setError(data.error || null);
      } catch (e) {
        if (!cancelled) { setSymbols([]); setError(e.message); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timerRef.current); };
  }, [open, query, accountId]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const commit = (symbol) => {
    onChange(String(symbol || "").toUpperCase());
    setOpen(false);
    setQuery("");
  };

  const recent = useMemo(() => symbols.filter((s) => s.recent), [symbols]);
  const others = useMemo(() => symbols.filter((s) => !s.recent), [symbols]);
  const typed = query.trim().toUpperCase();
  const exactListed = symbols.some((s) => s.symbol === typed);

  const row = (s) => (
    <button
      key={s.symbol}
      type="button"
      onClick={() => commit(s.symbol)}
      className={`flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-slate-50 ${
        s.symbol === value ? "bg-brand/5" : ""
      }`}
    >
      <span className="w-20 shrink-0 font-semibold text-slate-800">{s.symbol}</span>
      <span className="truncate text-xs text-slate-500">{s.name}</span>
      {s.exchange && <span className="ml-auto shrink-0 text-[10px] text-slate-400">{s.exchange}</span>}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
        className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm focus:border-brand focus:outline-none disabled:opacity-50"
      >
        {value
          ? <span className="font-semibold text-slate-800">{value}</span>
          : <span className="text-slate-400">— Select symbol —</span>}
        <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-3 py-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the top match, or the typed text when nothing
                // matched — so an unlisted symbol is still one keystroke away.
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (symbols.length) commit(symbols[0].symbol);
                else if (typed) commit(typed);
              }}
              placeholder="Search symbol or company…"
              className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs uppercase focus:border-brand focus:outline-none"
            />
          </div>

          {!accountId && (
            <p className="px-3 py-3 text-xs text-slate-400">
              Select an account first to load its symbols — or type one and press Enter.
            </p>
          )}

          {loading && <p className="px-3 py-3 text-xs text-slate-400">Searching…</p>}
          {error && !loading && <p className="px-3 py-3 text-xs text-red-600">{error}</p>}

          {!loading && recent.length > 0 && (
            <>
              <p className="bg-slate-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Traded on this account
              </p>
              {recent.map(row)}
            </>
          )}

          {!loading && others.length > 0 && (
            <>
              {recent.length > 0 && (
                <p className="bg-slate-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  All symbols
                </p>
              )}
              {others.map(row)}
            </>
          )}

          {!loading && !symbols.length && accountId && (
            <p className="px-3 py-3 text-xs text-slate-400">
              {query ? `Nothing listed matches “${query}”.` : "No symbols available."}
            </p>
          )}

          {/* Escape hatch, shown only when the typed text is not already on
              offer, so it never duplicates a real row. */}
          {!loading && typed && !exactListed && (
            <button
              type="button"
              onClick={() => commit(typed)}
              className="block w-full border-t border-slate-100 px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"
            >
              Use “<span className="font-semibold text-slate-700">{typed}</span>” anyway — not listed on this account
            </button>
          )}
        </div>
      )}
    </div>
  );
}

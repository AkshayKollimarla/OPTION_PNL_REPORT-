"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Column widths shared by the header and every row, so the two cannot drift
// apart the way they would if each were laid out independently.
const COLS = "grid grid-cols-[6.5rem_1fr_5.5rem_6.5rem_5rem] gap-3 items-center";

// A strategy picker with column headings.
//
// A native <select> cannot do this: its options are plain text, so there is
// nowhere to put a header row and no way to align entry date, coin, legs and
// exit date into columns. This is a button plus a listbox panel, which also
// allows OPEN to be coloured without relying on per-<option> colour support.
export default function StrategySelect({ units, value, onChange, fmtDate }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  // Close on an outside click or Escape — a panel that can only be dismissed
  // by picking something is a trap.
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

  const selected = units.find((u) => u.id === String(value));

  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return units;
    return units.filter((u) =>
      u.token.toUpperCase().includes(q) ||
      u.status.includes(q) ||
      (u.types || []).some((t) => String(t).toUpperCase().includes(q))
    );
  }, [units, query]);

  const statusCls = (s) =>
    s === "OPEN" ? "text-emerald-600 font-semibold" : "text-slate-800 font-semibold";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
        className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-sm focus:border-brand focus:outline-none"
      >
        {selected ? (
          <span className="flex items-center gap-2 truncate">
            <span className="text-slate-500">{fmtDate(selected.entry_date)}</span>
            <span className="font-semibold text-slate-800">{selected.token}</span>
            <span className="text-slate-500">
              {selected.legs.length > 1 ? `${selected.legs.length} legs` : selected.types[0] || "—"}
            </span>
            <span className="text-slate-500">
              → {selected.end_date ? fmtDate(selected.end_date) : "open"}
            </span>
            <span className={statusCls(selected.status)}>{selected.status}</span>
          </span>
        ) : (
          <span className="text-slate-400">— Select a strategy —</span>
        )}
        <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 max-h-96 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-3 py-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by coin, type or status…"
              className="w-full rounded border border-slate-200 px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
            />
          </div>

          {/* Header row. Sits below the search box, both pinned while the list
              scrolls, so the columns stay identified however far down you are. */}
          <div className={`${COLS} sticky top-[3.25rem] z-10 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400`}>
            <span>Entry Date</span>
            <span>Coin</span>
            <span>Legs</span>
            <span>Exit Date</span>
            <span className="text-right">Status</span>
          </div>

          <button
            type="button"
            onClick={() => { onChange(""); setOpen(false); }}
            className="block w-full px-3 py-2 text-left text-sm text-slate-400 hover:bg-slate-50"
          >
            — Select a strategy —
          </button>

          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-slate-400">No strategies match “{query}”.</p>
          )}

          {shown.map((u) => (
            <button
              key={u.key}
              type="button"
              onClick={() => { onChange(u.id); setOpen(false); }}
              className={`${COLS} w-full border-b border-dashed border-slate-100 px-3 py-2 text-left text-sm last:border-0 hover:bg-slate-50 ${
                u.id === String(value) ? "bg-brand/5" : ""
              }`}
            >
              <span className="text-slate-500 whitespace-nowrap">{fmtDate(u.entry_date)}</span>
              <span className="font-semibold text-slate-800 truncate">{u.token}</span>
              <span className="text-slate-500 whitespace-nowrap">
                {u.legs.length > 1 ? `${u.legs.length} legs` : u.types[0] || "—"}
              </span>
              <span className="text-slate-500 whitespace-nowrap">
                {u.end_date ? fmtDate(u.end_date) : "—"}
              </span>
              <span className={`text-right whitespace-nowrap ${statusCls(u.status)}`}>{u.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  HEADER_FIELDS,
  METRIC_CARDS,
  BOT_DETAILS_LEFT,
  BOT_DETAILS_RIGHT,
} from "../../lib/fields";
import { FORMULAS } from "../../lib/formulas";

const ALL_FORM_FIELDS = [...HEADER_FIELDS, ...METRIC_CARDS, ...BOT_DETAILS_LEFT, ...BOT_DETAILS_RIGHT];
const FORMULA_KEYS = new Set(Object.keys(FORMULAS));

const SECTIONS = [
  { title: "Token Info", fields: HEADER_FIELDS },
  { title: "Performance Metrics", fields: METRIC_CARDS },
  { title: "Bot Details — Position & Spread", fields: BOT_DETAILS_LEFT },
  { title: "Bot Details — Baskets & Limits", fields: BOT_DETAILS_RIGHT },
];

function emptyForm() {
  const f = { entry_datetime: localNow() };
  ALL_FORM_FIELDS.forEach((field) => { f[field.key] = ""; });
  return f;
}

function formFromEntry(entry) {
  const f = { entry_datetime: toDatetimeLocal(entry.entry_datetime) };
  ALL_FORM_FIELDS.forEach((field) => {
    const val = entry[field.key];
    f[field.key] = val === null || val === undefined ? "" : String(val);
  });
  return f;
}

// Apply all formulas to a form snapshot, skipping overridden keys.
// Passes `updated` (not the original `form`) to each fn so that a formula
// can read values produced by an earlier formula in the same pass.
function applyFormulas(form, overrides) {
  if (FORMULA_KEYS.size === 0) return form;
  const updated = { ...form };
  for (const [key, fn] of Object.entries(FORMULAS)) {
    if (overrides.has(key)) continue;
    try {
      const result = fn(updated); // ← use running state, not original snapshot
      if (result === null || result === undefined || result === "") {
        updated[key] = "";
      } else if (typeof result === "number" && isFinite(result)) {
        updated[key] = String(parseFloat(result.toFixed(2)));
      } else {
        updated[key] = String(result);
      }
    } catch {
      // formula error — leave field as-is
    }
  }
  return updated;
}

function ManualEntryInner() {
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");

  const [form, setForm] = useState(() => applyFormulas(emptyForm(), new Set()));
  const [overrides, setOverrides] = useState(new Set()); // keys where user overrode a formula
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loadingFrom, setLoadingFrom] = useState(false);
  const [sourceId, setSourceId] = useState(null);

  // Pre-fill from an existing entry when ?from=<id> is in the URL
  useEffect(() => {
    if (!fromId) return;
    setLoadingFrom(true);
    setStatus(null);
    fetch(`/api/entries/${fromId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) throw new Error(json.error);
        const filled = formFromEntry(json.entry);
        setForm(applyFormulas(filled, new Set()));
        setOverrides(new Set());
        setSourceId(json.entry.id);
      })
      .catch((e) => setStatus({ type: "error", msg: `Could not load entry #${fromId}: ${e.message}` }))
      .finally(() => setLoadingFrom(false));
  }, [fromId]);

  const update = useCallback((key, val) => {
    setForm((prev) => {
      const next = { ...prev, [key]: val };
      return applyFormulas(next, overrides);
    });
  }, [overrides]);

  // When user manually types into a formula field → mark as overridden
  const updateOverride = useCallback((key, val) => {
    setOverrides((prev) => new Set([...prev, key]));
    setForm((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Remove override — let formula take over again
  const clearOverride = useCallback((key) => {
    setOverrides((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setForm((prev) => applyFormulas(prev, (() => { const s = new Set(overrides); s.delete(key); return s; })()));
  }, [overrides]);

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setStatus({ type: "ok", msg: `Saved as new entry #${json.id}.` });
      setSourceId(null);
    } catch (err) {
      setStatus({ type: "error", msg: err.message });
    } finally {
      setSaving(false);
    }
  }

  const hasFormulas = FORMULA_KEYS.size > 0;

  return (
    <div>
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Manual Entry</h1>
          {sourceId && (
            <p className="text-xs text-slate-400 mt-0.5">
              Pre-filled from entry #{sourceId} — saving will create a new record
            </p>
          )}
        </div>
        {hasFormulas && (
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-600">
            {FORMULA_KEYS.size} auto-formula{FORMULA_KEYS.size > 1 ? "s" : ""} active
          </span>
        )}
      </header>

      {loadingFrom ? (
        <div className="p-6 text-sm text-slate-400">Loading entry data…</div>
      ) : (
        <form onSubmit={onSubmit} className="p-6 space-y-6">
          <p className="text-sm text-slate-500">
            {sourceId
              ? "Fields are pre-filled from a previous entry. Change what you need, then save — this will create a new log entry."
              : "Enter the bot values below. On save, the record is written to MySQL and shown on the Dashboard."}
            {hasFormulas && " Fields highlighted in blue are auto-calculated — click Override to enter manually."}
          </p>

          {status && (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                status.type === "ok"
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {status.msg}
            </div>
          )}

          {/* Date/time */}
          <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">Entry Date &amp; Time</h2>
            <div className="max-w-xs">
              <label className="mb-1.5 block text-sm font-medium text-slate-600">Date Time</label>
              <input
                type="datetime-local"
                value={form.entry_datetime}
                onChange={(e) => update("entry_datetime", e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                required
              />
            </div>
          </div>

          {SECTIONS.map((section) => (
            <div key={section.title} className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
              <h2 className="mb-4 text-sm font-semibold text-slate-700">{section.title}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {section.fields.map((field) => {
                  const isFormula = FORMULA_KEYS.has(field.key);
                  const isOverridden = overrides.has(field.key);
                  const autoActive = isFormula && !isOverridden;
                  return (
                    <div key={field.key}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="text-sm font-medium text-slate-600">
                          {field.label}
                          {field.format === "percent" && " (%)"}
                        </label>
                        {isFormula && (
                          autoActive ? (
                            <button
                              type="button"
                              onClick={() => updateOverride(field.key, form[field.key])}
                              className="text-xs text-blue-500 hover:text-blue-700 font-medium"
                            >
                              Override
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => clearOverride(field.key)}
                              className="text-xs text-slate-400 hover:text-slate-600 font-medium"
                            >
                              ↺ Auto
                            </button>
                          )
                        )}
                      </div>
                      <input
                        type={field.format === "text" ? "text" : "number"}
                        step={field.format === "text" ? undefined : "any"}
                        placeholder={field.placeholder || ""}
                        value={form[field.key]}
                        readOnly={autoActive}
                        onChange={(e) =>
                          autoActive ? undefined : isFormula
                            ? updateOverride(field.key, e.target.value)
                            : update(field.key, e.target.value)
                        }
                        className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none ${
                          autoActive
                            ? "border-blue-200 bg-blue-50 text-blue-700 cursor-default"
                            : "border-slate-200 focus:border-brand"
                        }`}
                        required={field.key === "token_name"}
                      />
                      {autoActive && (
                        <p className="mt-0.5 text-xs text-blue-400">auto-calculated</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {saving ? "Saving…" : "Save as New Entry"}
            </button>
            <button
              type="button"
              onClick={() => { setForm(applyFormulas(emptyForm(), new Set())); setOverrides(new Set()); setSourceId(null); }}
              className="rounded-lg border border-slate-200 px-6 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Reset
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function ManualEntry() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-400">Loading…</div>}>
      <ManualEntryInner />
    </Suspense>
  );
}

function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocal(dt) {
  if (!dt) return localNow();
  const d = new Date(String(dt).replace(" ", "T"));
  if (isNaN(d)) return localNow();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

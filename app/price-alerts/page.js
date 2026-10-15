"use client";

import { useCallback, useEffect, useState } from "react";

/* The watch list is the open strategies themselves, so there is nothing to
   add or delete here: a structure opened on the Options Dashboard appears,
   and one closed there leaves. Only the thresholds are yours to set. */

const money = (v, places = 4) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? "—"
    : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: places });

export default function PriceAlertsPage() {
  const [rows, setRows]       = useState([]);
  const [telegram, setTg]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  // Edits live here until Save, so a half-typed number never reaches the
  // worker that decides whether to wake someone up.
  const [draft, setDraft]     = useState({});
  const [saving, setSaving]   = useState(null);
  const [saved, setSaved]     = useState(null);

  const load = useCallback(() => {
    fetch("/api/price-alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setRows(j.rows || []);
        setTg(j.telegram || null);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  // The price is the point of the page, so it keeps itself current. Edits in
  // progress are held in `draft` and survive the refresh.
  useEffect(() => {
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  // An empty box means "follow the limit", so only a value the user typed is
  // shown; the computed one is the placeholder beneath it.
  const valueOf = (row, field) => {
    const d = draft[row.key] || {};
    if (d[field] !== undefined) return d[field];
    if (field === "offset") return String(row.offset ?? 1);
    if (field === "upper")  return row.upperManual ? String(row.upperTrigger ?? "") : "";
    if (field === "lower")  return row.lowerManual ? String(row.lowerTrigger ?? "") : "";
    return "";
  };
  const setField = (row, field, value) =>
    setDraft((p) => ({ ...p, [row.key]: { ...(p[row.key] || {}), [field]: value } }));

  async function save(row) {
    setSaving(row.key); setSaved(null);
    const d = draft[row.key] || {};
    try {
      const res = await fetch("/api/price-alerts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: row.key,
          offset_usd: d.offset !== undefined ? d.offset : row.offset,
          // Empty means "follow the limit", not zero.
          alert_upper: d.upper !== undefined ? (d.upper === "" ? null : d.upper) : (row.upperManual ? row.upperTrigger : null),
          alert_lower: d.lower !== undefined ? (d.lower === "" ? null : d.lower) : (row.lowerManual ? row.lowerTrigger : null),
          enabled: d.enabled !== undefined ? d.enabled : row.enabled,
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      setDraft((p) => { const n = { ...p }; delete n[row.key]; return n; });
      setSaved(row.key);
      load();
      setTimeout(() => setSaved(null), 2500);
    } catch (e) { setError(e.message); }
    finally { setSaving(null); }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Price Alerts</h1>
          <p className="text-xs text-slate-400">
            One card per open strategy — alerts fire before a coin reaches the strikes protecting it
          </p>
        </div>
        {telegram && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
            telegram.configured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {telegram.configured
              ? (telegram.dedicated ? "Telegram: own bot" : "Telegram: shared bot")
              : "Telegram not configured"}
          </span>
        )}
      </header>

      <div className="p-6 space-y-5">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {!telegram?.configured && !loading && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            No Telegram bot is set up yet, so these alerts have nowhere to go. Create your bot, then
            set <code className="font-mono text-xs">PRICE_ALERT_BOT_TOKEN</code> and
            {" "}<code className="font-mono text-xs">PRICE_ALERT_CHAT_ID</code> on the server. Everything below
            can be set up in the meantime.
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border border-slate-100 bg-white px-6 py-16 text-center text-sm text-slate-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-slate-100 bg-white px-6 py-16 text-center">
            <p className="text-sm font-semibold text-slate-600">No open strategies to watch</p>
            <p className="mt-1 text-sm text-slate-400">
              This page follows the open strategies on the Options Dashboard. Open one and it appears here
              with its limits already filled in.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {rows.map((row) => {
              const dirty = Boolean(draft[row.key]);
              const enabled = (draft[row.key]?.enabled ?? row.enabled) !== false;
              return (
                <div key={row.key} className="rounded-2xl border border-slate-200 bg-white shadow-card overflow-hidden">
                  {/* Coin, price, and how far it is from each limit */}
                  <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-lg bg-brand/10 px-2.5 py-1 text-sm font-bold text-brand">{row.coin}</span>
                        <span className="text-xs text-slate-400">{row.account || "no account"} · {row.legs} legs</span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-400">
                        entered {row.entry_date || "—"}{row.expiry ? ` · expiry ${row.expiry}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold tabular-nums text-slate-800">{money(row.price)}</p>
                      <p className="text-[11px] text-slate-400">
                        {row.priceSource || "no feed"}
                        {row.delayedMinutes ? ` · ${row.delayedMinutes} min behind` : ""}
                      </p>
                    </div>
                  </div>

                  {(row.priceError || row.priceMismatch) && (
                    <div className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-[11px] text-amber-800">
                      {row.priceError
                        ? row.priceError
                        : `The live price is far outside this strategy's band, so it is probably a different market of the same name. No alert will be sent while that is true.`}
                    </div>
                  )}

                  {/* The band, and where the alerts sit inside it */}
                  <div className="grid grid-cols-2 gap-px bg-slate-100">
                    <Limit dir="up"   title="Upper limit" limit={row.upper} from={row.upperFrom}
                           trigger={row.upperTrigger} price={row.price} />
                    <Limit dir="down" title="Lower limit" limit={row.lower} from={row.lowerFrom}
                           trigger={row.lowerTrigger} price={row.price} />
                  </div>

                  {/* The three things that are yours to set */}
                  <div className="space-y-3 px-5 py-4">
                    <Field
                      label="Alert this far before a limit ($)"
                      hint="Used for whichever side you have not set outright"
                      value={valueOf(row, "offset")}
                      placeholder="1"
                      onChange={(v) => setField(row, "offset", v)}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Field
                        label="Alert at (upper)"
                        hint={row.upperManual ? "your value" : "auto"}
                        value={valueOf(row, "upper")}
                        placeholder={row.upperTrigger != null ? String(row.upperTrigger) : ""}
                        onChange={(v) => setField(row, "upper", v)}
                      />
                      <Field
                        label="Alert at (lower)"
                        hint={row.lowerManual ? "your value" : "auto"}
                        value={valueOf(row, "lower")}
                        placeholder={row.lowerTrigger != null ? String(row.lowerTrigger) : ""}
                        onChange={(v) => setField(row, "lower", v)}
                      />
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => setField(row, "enabled", e.target.checked)}
                          className="h-4 w-4 accent-brand"
                        />
                        Alerts on
                      </label>
                      <div className="flex items-center gap-3">
                        {saved === row.key && <span className="text-xs font-semibold text-emerald-600">Saved</span>}
                        {row.lastFiredAt && saved !== row.key && (
                          <span className="text-[11px] text-slate-400">last sent {new Date(row.lastFiredAt).toLocaleString()}</span>
                        )}
                        <button
                          onClick={() => save(row)}
                          disabled={saving === row.key}
                          className={`rounded-lg px-5 py-2 text-sm font-bold text-white transition-colors disabled:opacity-60 ${
                            dirty ? "bg-brand hover:opacity-90" : "bg-slate-300 hover:bg-slate-400"}`}>
                          {saving === row.key ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* One side of the band: the limit itself, where it came from, and how far the
   price has to travel to reach it. */
function Limit({ dir, title, limit, from, price, trigger }) {
  const away = Number.isFinite(Number(price)) && limit != null
    ? (dir === "up" ? Number(limit) - Number(price) : Number(price) - Number(limit))
    : null;
  const close = away !== null && away <= 0;
  return (
    <div className={`px-5 py-4 ${dir === "up" ? "bg-emerald-50/50" : "bg-red-50/40"}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span className={`text-base font-extrabold leading-none ${dir === "up" ? "text-emerald-600" : "text-red-500"}`}>
          {dir === "up" ? "↑" : "↓"}
        </span>
        {title}
      </p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums ${dir === "up" ? "text-emerald-700" : "text-red-600"}`}>
        {money(limit)}
      </p>
      <p className="text-[11px] text-slate-400">
        {from ? `from the ${from}` : "not set"}
        {away !== null && ` · ${close ? "past it" : `${money(Math.abs(away))} away`}`}
      </p>
      <p className="text-[11px] font-medium text-slate-500">alerts at {money(trigger)}</p>
    </div>
  );
}

function Field({ label, hint, value, placeholder, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-slate-600">{label}</span>
        {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
      </span>
      <input
        type="number"
        step="any"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums focus:border-brand focus:outline-none"
      />
    </label>
  );
}

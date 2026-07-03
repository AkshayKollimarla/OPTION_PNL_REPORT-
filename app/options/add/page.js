"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { computeDerived } from "../../../lib/options-calculations";

const EMPTY = {
  entry_date:"", token:"", option_type:"PUT", investment:"", options_strike:"", expiry:"",
  opt_entry_qty:"", opt_entry_price:"", opt_exit_price:"",
  fut_qty:"", fut_entry_price:"", fut_exit_price:"",
  upside_distance:"", down_distance:"", basket_distance:"", basket_loss:"",
  net_booked_pnl:"", market_making_pl:"", end_date:"", status:"open",
};

export default function AddStrategy({ initialData, tradeId, isEdit }) {
  const router  = useRouter();
  const [form,    setForm]    = useState(initialData || EMPTY);
  const [derived, setDerived] = useState({});
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    setDerived(computeDerived(form));
  }, [form]);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true); setError(null); setSuccess(null);
    try {
      const url    = isEdit ? `/api/options/trades/${tradeId}` : "/api/options/trades";
      const method = isEdit ? "PUT" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const json   = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      if (isEdit) {
        setSuccess("Strategy updated.");
      } else {
        setSuccess(`Saved as strategy #${json.id}.`);
        setForm(EMPTY);
      }
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function saveAsNew() {
    setSaving(true); setError(null); setSuccess(null);
    try {
      // Strip group_id — a "save as new" copy is always standalone
      const { group_id, id, ...payload } = form;
      const res  = await fetch("/api/options/trades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSuccess(`Saved as new strategy #${json.id}. Redirecting…`);
      setTimeout(() => router.push(`/options/edit/${json.id}`), 1200);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div>
          <h1 className="text-lg font-bold text-slate-800">{isEdit ? "Edit / Close Strategy" : "Add Options Strategy"}</h1>
          {isEdit && <p className="text-xs text-slate-400 mt-0.5">Strategy #{tradeId}</p>}
        </div>
        <button onClick={() => router.back()} className="text-sm text-slate-500 hover:text-slate-700">← Back</button>
      </header>

      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* LEFT: input form (2 cols wide) */}
        <form onSubmit={onSubmit} className="xl:col-span-2 space-y-6">
          {error   && <Alert type="error">{error}</Alert>}
          {success && <Alert type="ok">{success}</Alert>}

          <Section title="Basic Info">
            <Field label="Entry Date" required><input type="date" value={form.entry_date} onChange={(e) => set("entry_date", e.target.value)} required className={inp} /></Field>
            <Field label="Token" required><input type="text" placeholder="e.g. BTC, HOOD" value={form.token} onChange={(e) => set("token", e.target.value)} required className={inp} /></Field>
            <Field label="Option Type">
              <select value={form.option_type} onChange={(e) => set("option_type", e.target.value)} className={inp}>
                <option value="PUT">PUT</option>
                <option value="CALL">CALL</option>
              </select>
            </Field>
            <Field label="Investment"><input type="number" step="any" value={form.investment} onChange={(e) => set("investment", e.target.value)} className={inp} /></Field>
            <Field label="Status">
              <select value={form.status} onChange={(e) => set("status", e.target.value)} className={inp}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
            <Field label="End Date"><input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className={inp} /></Field>
          </Section>

          <Section title="Option Details">
            <Field label="Strike (free text)" required><input type="text" placeholder='e.g. "96 PUT" or "1700-PE"' value={form.options_strike} onChange={(e) => set("options_strike", e.target.value)} className={inp} /></Field>
            <Field label="Expiry Date"><input type="date" value={form.expiry} onChange={(e) => set("expiry", e.target.value)} className={inp} /></Field>
            <Field label="Entry Qty"><input type="number" step="any" value={form.opt_entry_qty} onChange={(e) => set("opt_entry_qty", e.target.value)} className={inp} /></Field>
            <Field label="Entry Price"><input type="number" step="any" value={form.opt_entry_price} onChange={(e) => set("opt_entry_price", e.target.value)} className={inp} /></Field>
            <Field label="Exit Price"><input type="number" step="any" value={form.opt_exit_price} onChange={(e) => set("opt_exit_price", e.target.value)} className={inp} /></Field>
          </Section>

          <Section title="Futures Details">
            <Field label="Fut Qty"><input type="number" step="any" value={form.fut_qty} onChange={(e) => set("fut_qty", e.target.value)} className={inp} /></Field>
            <Field label="Fut Entry Price"><input type="number" step="any" value={form.fut_entry_price} onChange={(e) => set("fut_entry_price", e.target.value)} className={inp} /></Field>
            <Field label="Fut Exit Price"><input type="number" step="any" value={form.fut_exit_price} onChange={(e) => set("fut_exit_price", e.target.value)} className={inp} /></Field>
          </Section>

          <Section title="Distances & Basket">
            <Field label="Upside Distance"><input type="number" step="any" value={form.upside_distance} onChange={(e) => set("upside_distance", e.target.value)} className={inp} /></Field>
            <Field label="Down Distance"><input type="number" step="any" value={form.down_distance} onChange={(e) => set("down_distance", e.target.value)} className={inp} /></Field>
            <Field label="Basket Distance"><input type="number" step="any" value={form.basket_distance} onChange={(e) => set("basket_distance", e.target.value)} className={inp} /></Field>
            <Field label="Basket Loss"><input type="number" step="any" value={form.basket_loss} onChange={(e) => set("basket_loss", e.target.value)} className={inp} /></Field>
          </Section>

          <Section title="Close / Booked">
            <Field label="Net Booked PnL"><input type="number" step="any" value={form.net_booked_pnl} onChange={(e) => set("net_booked_pnl", e.target.value)} className={inp} /></Field>
            <Field label="Market Making PL"><input type="number" step="any" value={form.market_making_pl} onChange={(e) => set("market_making_pl", e.target.value)} className={inp} /></Field>
          </Section>

          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={saving}
              className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors">
              {saving ? "Saving…" : isEdit ? "Update Strategy" : "Save Strategy"}
            </button>
            {isEdit && (
              <button type="button" onClick={saveAsNew} disabled={saving}
                className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
                {saving ? "Saving…" : "Save as New Strategy"}
              </button>
            )}
            <button type="button" onClick={() => setForm(EMPTY)}
              className="rounded-lg border border-slate-200 px-6 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Reset
            </button>
          </div>
        </form>

        {/* RIGHT: live auto-calc panel */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card sticky top-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">Auto-Calculated (Live)</h2>

            <CalcGroup title="General / Theta">
              <CalcRow label="Days to Expiry"    value={fmt(derived.days_to_expiry, "number")} />
              <CalcRow label="Total Theta"        value={fmt(derived.total_theta_gain_loss)} />
              <CalcRow label="Per Day Theta"      value={fmt(derived.per_day_theta_gain_loss)} />
              <CalcRow label="Total Baskets"      value={fmt(derived.total_baskets, "number")} />
              <CalcRow label="Total MM Loss"      value={fmt(derived.total_mm_loss)} loss />
            </CalcGroup>

            <CalcGroup title="Limits">
              <CalcRow label="Upper Limit"  value={fmt(derived.upper_limit, "number")} />
              <CalcRow label="Lower Limit"  value={fmt(derived.lower_limit, "number")} />
            </CalcGroup>

            <CalcGroup title="📈 Upside">
              <CalcRow label="Opt PnL (Upside)"  value={fmt(derived.upside_opt_pnl)} signed />
              <CalcRow label="Fut PnL (Upside)"  value={fmt(derived.upside_fut_pnl)} signed />
              <CalcRow label="Est. Net (Upside)"  value={fmt(derived.estimated_upside_net_pnl)} signed big />
            </CalcGroup>

            <CalcGroup title="📉 Downside">
              <CalcRow label="Opt PnL (Down)"    value={fmt(derived.down_opt_pnl)} signed />
              <CalcRow label="Fut PnL (Down)"    value={fmt(derived.downside_fut_pnl)} signed />
              <CalcRow label="Est. Net (Down)"    value={fmt(derived.estimated_downside_net_pnl)} signed big />
            </CalcGroup>

            <CalcGroup title="Return">
              <CalcRow label="APY" value={derived.apy != null ? `${Number(derived.apy).toFixed(2)}%` : "—"} signed big />
            </CalcGroup>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────── */

const inp = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none";

function Section({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
      <h2 className="mb-4 text-sm font-semibold text-slate-700">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

function Field({ label, children, required }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-slate-600">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function CalcGroup({ title, children }) {
  return (
    <div className="mb-4">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function CalcRow({ label, value, signed, loss, big }) {
  const rawNum = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(rawNum);
  const isNeg = signed && isNum && rawNum < 0;
  const isPos = signed && isNum && rawNum >= 0;
  const color = loss ? "text-red-600" : isNeg ? "text-red-700" : isPos ? "text-emerald-700" : "text-slate-700";
  return (
    <div className="flex items-center justify-between py-1 border-b border-dashed border-slate-100">
      <span className={big ? "text-sm font-bold text-slate-800" : "text-xs text-slate-500"}>{label}</span>
      <span className={`${big ? "text-base font-extrabold" : "text-xs font-semibold"} ${color}`}>{value ?? "—"}</span>
    </div>
  );
}

function Alert({ type, children }) {
  const cls = type === "ok"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-red-200 bg-red-50 text-red-700";
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

function fmt(v, type) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || isNaN(n)) return "—";
  if (type === "number") return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

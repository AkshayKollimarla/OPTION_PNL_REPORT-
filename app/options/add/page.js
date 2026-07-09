"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { computeDerived, strikeNumber } from "../../../lib/options-calculations";
import { expiryPnl, currentPnl } from "../../../lib/black-scholes";
import LiveOptionPicker from "../../../components/LiveOptionPicker";

const RISK_FREE = 0.05;

const EMPTY = {
  entry_date:"", token:"", option_type:"PUT", investment:"", options_strike:"", expiry:"",
  opt_entry_qty:"", opt_entry_price:"", opt_exit_price:"", iv:"",
  fut_qty:"", fut_entry_price:"", fut_exit_price:"",
  upside_distance:"", down_distance:"", basket_distance:"", basket_loss:"",
  net_booked_pnl:"", market_making_pl:"", end_date:"", status:"open",
};

export default function AddStrategy({ initialData, tradeId, isEdit }) {
  const router  = useRouter();
  const [form,           setForm]           = useState(initialData || EMPTY);
  const [derived,        setDerived]        = useState({});
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState(null);
  const [success,        setSuccess]        = useState(null);
  const [accounts,       setAccounts]       = useState([]);
  const [selectedAcct,   setSelectedAcct]   = useState("");
  const [executing,      setExecuting]      = useState(false);
  const [executeResult,  setExecuteResult]  = useState(null);
  const [executeError,   setExecuteError]   = useState(null);
  const instrumentRef = useRef({ option: "", future: "" });

  useEffect(() => {
    setDerived(computeDerived(form));
  }, [form]);

  useEffect(() => {
    fetch("/api/accounts")
      .then(r => r.json())
      .then(d => setAccounts(d.accounts || []))
      .catch(() => {});
  }, []);

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  function handleLiveFill({ expiry, strike, option_type, opt_entry_price, iv, fut_entry_price, instrument_name, future_instrument }) {
    setForm(f => ({
      ...f,
      options_strike:  strike,
      expiry:          expiry,
      option_type:     option_type,
      opt_entry_price: opt_entry_price,
      iv:              iv,
      fut_entry_price: fut_entry_price,
    }));
    instrumentRef.current = { option: instrument_name, future: future_instrument };
  }

  async function handleExecute() {
    setExecuteError(null); setExecuteResult(null);
    if (!selectedAcct) { setExecuteError("Select an account first."); return; }
    const optQty = parseFloat(form.opt_entry_qty) || 0;
    const futQty = parseFloat(form.fut_qty) || 0;
    if (optQty === 0 && futQty === 0) { setExecuteError("Enter option qty and/or futures qty."); return; }

    const optInst = instrumentRef.current.option;
    const futInst = instrumentRef.current.future || `${(form.token || "ETH").toUpperCase()}-PERPETUAL`;
    if (optQty !== 0 && !optInst) { setExecuteError("Use Live Market Data to select the instrument first (sets option instrument name)."); return; }

    setExecuting(true);
    try {
      const res  = await fetch("/api/execute", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ account_id: selectedAcct, option_instrument: optQty !== 0 ? optInst : null, option_qty: optQty, future_instrument: futQty !== 0 ? futInst : null, future_qty: futQty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Execute failed");
      setExecuteResult(data.results);
    } catch (e) {
      setExecuteError(e.message);
    } finally {
      setExecuting(false);
    }
  }

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

  // Black-Scholes estimates (live, computed from current form)
  const K_bs       = strikeNumber(form.options_strike);
  const ep_bs      = parseFloat(form.opt_entry_price) || 0;
  const qty_bs     = parseFloat(form.opt_entry_qty)   || 0;
  const S_bs       = parseFloat(form.fut_entry_price) || K_bs || 0;
  const sigma_bs   = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
  const optType_bs = (form.option_type || "PUT").toUpperCase();
  const today_d    = new Date(); today_d.setHours(0, 0, 0, 0);
  const expiry_d   = form.expiry ? (() => { const d = new Date(form.expiry); d.setHours(0,0,0,0); return d; })() : null;
  const dte_bs     = expiry_d ? Math.max(0, Math.round((expiry_d - today_d) / 86400000)) : 0;
  const T_bs       = dte_bs / 365;
  const S_up_bs    = S_bs + (parseFloat(form.upside_distance) || 0);
  const S_dn_bs    = S_bs - (parseFloat(form.down_distance)   || 0);
  const hasBS      = K_bs > 0 && qty_bs !== 0;
  const bsUpsidePnl      = hasBS ? expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs) : null;
  const bsDownPnl        = hasBS ? expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs) : null;
  const bsUpsideTodayPnl = hasBS && S_up_bs > 0
    ? (T_bs > 0 ? currentPnl(S_up_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsDownTodayPnl   = hasBS && S_dn_bs > 0
    ? (T_bs > 0 ? currentPnl(S_dn_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsTodayPnl       = hasBS && S_bs > 0
    ? (T_bs > 0 ? currentPnl(S_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsBreakeven = K_bs > 0 ? (optType_bs === "CALL" ? K_bs + ep_bs : K_bs - ep_bs) : null;
  const futUp_bs  = Number(derived.upside_fut_pnl)   || 0;
  const futDn_bs  = Number(derived.downside_fut_pnl) || 0;
  const mm_bs     = Number(derived.total_mm_loss)    || 0;
  const bsNetUpsideToday   = bsUpsideTodayPnl != null ? bsUpsideTodayPnl + futUp_bs + mm_bs : null;
  const bsNetDownToday     = bsDownTodayPnl   != null ? bsDownTodayPnl   + futDn_bs + mm_bs : null;
  const bsNetUpsideExpiry  = bsUpsidePnl      != null ? bsUpsidePnl      + futUp_bs + mm_bs : null;
  const bsNetDownExpiry    = bsDownPnl        != null ? bsDownPnl        + futDn_bs + mm_bs : null;

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

          {/* Account Selector */}
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-indigo-300">Exchange Account</h2>
            <div className="flex items-center gap-3">
              <select
                value={selectedAcct}
                onChange={e => setSelectedAcct(e.target.value)}
                className="flex-1 rounded-lg border border-white/10 bg-[#1e2740] px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">— No account (manual entry) —</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.exchange}{a.testnet ? " (Testnet)" : ""}
                  </option>
                ))}
              </select>
              <a href="/accounts" target="_blank"
                className="text-xs text-indigo-400 hover:text-indigo-300 whitespace-nowrap transition-colors">
                + Manage
              </a>
            </div>

            {/* Live Option Picker */}
            {selectedAcct && (
              <LiveOptionPicker
                accountId={selectedAcct}
                token={form.token || "ETH"}
                optionType={form.option_type || "PUT"}
                onFill={handleLiveFill}
              />
            )}
          </div>

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
            <Field label="Implied Volatility (%)"><input type="number" step="0.5" min="1" max="500" placeholder="e.g. 30" value={form.iv} onChange={(e) => set("iv", e.target.value)} className={inp} /></Field>
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
            <button
              type="button"
              onClick={handleExecute}
              disabled={executing || !selectedAcct}
              className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
            >
              {executing ? "Placing Orders…" : "⚡ Execute (Option + Futures)"}
            </button>
          </div>

          {/* Execute feedback */}
          {executeError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              Execute Error: {executeError}
            </div>
          )}
          {executeResult && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 space-y-1">
              <p className="font-semibold">Orders Placed Successfully</p>
              {executeResult.option  && <p>Option  — Order ID: {executeResult.option?.order?.order_id  ?? JSON.stringify(executeResult.option)}</p>}
              {executeResult.futures && <p>Futures — Order ID: {executeResult.futures?.order?.order_id ?? JSON.stringify(executeResult.futures)}</p>}
            </div>
          )}
        </form>

        {/* RIGHT: live auto-calc panel */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card sticky top-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">Auto-Calculated (Live)</h2>

            <CalcGroup title="General / Theta">
              <CalcRow label="Days to Expiry"    value={fmt(derived.days_to_expiry, "number")} />
              <CalcRow label="Total Theta"        value={fmt(derived.total_theta_gain_loss)} />
              <CalcRow label="Per Day Theta"      value={fmt(derived.per_day_theta_gain_loss)} signed />
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
            </CalcGroup>

            <CalcGroup title="📉 Downside">
              <CalcRow label="Opt PnL (Down)"    value={fmt(derived.down_opt_pnl)} signed />
              <CalcRow label="Fut PnL (Down)"    value={fmt(derived.downside_fut_pnl)} signed />
            </CalcGroup>

            <CalcGroup title="Return">
              <CalcRow label="APY" value={derived.apy != null ? `${Number(derived.apy).toFixed(2)}%` : "—"} signed big />
            </CalcGroup>

            <CalcGroup title="📊 BS Option PNL">
              <CalcRow label="Upside Opt (Today BS)"     value={fmt(bsUpsideTodayPnl)} signed />
              <CalcRow label="Downside Opt (Today BS)"   value={fmt(bsDownTodayPnl)}   signed />
              <CalcRow label="Upside Opt (Expiry)"       value={fmt(bsUpsidePnl)}       signed />
              <CalcRow label="Downside Opt (Expiry)"     value={fmt(bsDownPnl)}         signed />
              <CalcRow label="Fut PnL (Upside)"          value={fmt(futUp_bs)}          signed />
              <CalcRow label="Fut PnL (Downside)"        value={fmt(futDn_bs)}          signed />
              <CalcRow label="Total MM Loss"             value={fmt(mm_bs)}             loss />
              <CalcRow label="Net BS Upside (Today)"     value={fmt(bsNetUpsideToday)}  signed big />
              <CalcRow label="Net BS Downside (Today)"   value={fmt(bsNetDownToday)}    signed big />
              <CalcRow label="Est Net Upside (Expiry)"   value={fmt(bsNetUpsideExpiry)} signed big />
              <CalcRow label="Est Net Downside (Expiry)" value={fmt(bsNetDownExpiry)}   signed big />
              <CalcRow label={`At Current Price (Today BS, ${dte_bs}d)`} value={fmt(bsTodayPnl)} signed big />
              <CalcRow label="Breakeven Price" value={bsBreakeven != null ? bsBreakeven.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} />
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

function BsRow({ label, value, signed }) {
  const raw   = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(raw);
  const color = signed && isNum ? (raw >= 0 ? "text-emerald-600" : "text-red-600") : "text-slate-700";
  return (
    <div className="py-1.5 border-b border-dashed border-slate-100">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value ?? "—"}</div>
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

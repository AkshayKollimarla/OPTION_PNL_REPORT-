"use client";

import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { computeDerived, strikeNumber } from "../../../lib/options-calculations";
import { expiryPnl, currentPnl } from "../../../lib/black-scholes";
import LiveOptionPicker from "../../../components/LiveOptionPicker";

const RISK_FREE = 0.05;

const EMPTY = {
  entry_date: "", token: "", investment: "",
  options_strike: "", expiry: "",
  opt_entry_qty: "", opt_entry_price: "", opt_exit_price: "", iv: "",
  fut_qty: "", fut_entry_price: "", fut_exit_price: "",
  upside_distance: "", down_distance: "", basket_distance: "", basket_loss: "",
  net_booked_pnl: "", market_making_pl: "", end_date: "", status: "open",
};

const LEG_OPTIONS = ["CALL LONG", "CALL SHORT", "PUT LONG", "PUT SHORT"];

const LEG_STYLES = {
  "CALL LONG":  { badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", txt: "text-emerald-700" },
  "CALL SHORT": { badge: "bg-orange-100  text-orange-700  border-orange-200",  dot: "bg-orange-500",  txt: "text-orange-700"  },
  "PUT LONG":   { badge: "bg-blue-100    text-blue-700    border-blue-200",    dot: "bg-blue-500",    txt: "text-blue-700"    },
  "PUT SHORT":  { badge: "bg-red-100     text-red-700     border-red-200",     dot: "bg-red-500",     txt: "text-red-700"     },
};

const n = (v) => Number(v) || 0;

function applyLegType(form, legType) {
  const isCall  = legType.startsWith("CALL");
  const isShort = legType.endsWith("SHORT");
  const raw     = form.opt_entry_qty;
  let newQty    = raw;
  if (raw !== "" && !isNaN(Number(raw))) {
    const abs = Math.abs(Number(raw)) || "";
    newQty = abs === "" ? "" : isShort ? -abs : abs;
  }
  return { ...form, option_type: isCall ? "CALL" : "PUT", opt_entry_qty: String(newQty === "" ? "" : newQty) };
}

function detectLegType(trade) {
  const isCall  = (trade.option_type || "").toUpperCase() === "CALL";
  const isShort = Number(trade.opt_entry_qty) < 0;
  if (isCall  && !isShort) return "CALL LONG";
  if (isCall  &&  isShort) return "CALL SHORT";
  if (!isCall && !isShort) return "PUT LONG";
  return "PUT SHORT";
}

function toFormDate(d) {
  if (!d) return "";
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s.replace(" ", "T"));
  if (isNaN(dt)) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

function tradeToForm(t) {
  return {
    entry_date:       toFormDate(t.entry_date)   || "",
    token:            t.token                    || "",
    investment:       t.investment               ?? "",
    options_strike:   t.options_strike           || "",
    expiry:           toFormDate(t.expiry)        || "",
    opt_entry_qty:    t.opt_entry_qty             ?? "",
    opt_entry_price:  t.opt_entry_price           ?? "",
    opt_exit_price:   t.opt_exit_price            ?? "",
    fut_qty:          t.fut_qty                   ?? "",
    fut_entry_price:  t.fut_entry_price           ?? "",
    fut_exit_price:   t.fut_exit_price            ?? "",
    upside_distance:  t.upside_distance           ?? "",
    down_distance:    t.down_distance             ?? "",
    basket_distance:  t.basket_distance           ?? "",
    basket_loss:      t.basket_loss               ?? "",
    net_booked_pnl:   t.net_booked_pnl            ?? "",
    market_making_pl: t.market_making_pl          ?? "",
    end_date:         toFormDate(t.end_date)      || "",
    status:           t.status                   || "open",
    option_type:      t.option_type              || "CALL",
  };
}

const makeLeg = (type = "CALL LONG") => ({
  type,
  form: { ...EMPTY, option_type: type.startsWith("CALL") ? "CALL" : "PUT", iv: "" },
});

/* ── Main component ───────────────────────────────────── */

function SimulatorInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const editGroup    = searchParams.get("edit_group");
  const isEditMode   = !!editGroup;

  // Dynamic array of legs: [{ type, form }]
  const [legs,          setLegs]          = useState([makeLeg("CALL LONG"), makeLeg("PUT LONG")]);
  const [editIds,       setEditIds]       = useState([]); // DB IDs for existing legs (edit mode)
  const [loadErr,       setLoadErr]       = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState(null);
  const [saveErr,       setSaveErr]       = useState(null);
  const [accounts,      setAccounts]      = useState([]);
  const [selectedAcct,  setSelectedAcct]  = useState("");
  const [executing,     setExecuting]     = useState(false);
  const [executeResult, setExecuteResult] = useState(null);
  const [executeError,  setExecuteError]  = useState(null);
  const legInstrumentsRef = useRef([]); // [{ option, future }] per leg

  // Derived values computed for each leg
  const deriveds = useMemo(() => legs.map((l) => computeDerived(l.form)), [legs]);

  useEffect(() => {
    fetch("/api/accounts")
      .then(r => r.json())
      .then(d => setAccounts(d.accounts || []))
      .catch(() => {});
  }, []);

  // Load existing group in edit mode
  useEffect(() => {
    if (!editGroup) return;
    fetch(`/api/options/trades?group_id=${encodeURIComponent(editGroup)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        const members = j.trades || [];
        if (!members.length) throw new Error("No legs found for this group.");
        setLegs(members.map((t) => ({ type: detectLegType(t), form: tradeToForm(t) })));
        setEditIds(members.map((m) => m.id));
      })
      .catch((e) => setLoadErr(e.message));
  }, [editGroup]);

  /* ── Leg helpers ──────────────────────────────────── */
  function addLeg() {
    setLegs((prev) => [...prev, makeLeg("CALL LONG")]);
  }

  function removeLeg(idx) {
    if (legs.length <= 2) return;
    setLegs((prev)    => prev.filter((_, i) => i !== idx));
    setEditIds((prev) => prev.filter((_, i) => i !== idx));
  }

  function changeLegType(idx, type) {
    setLegs((prev) => prev.map((l, i) =>
      i === idx ? { ...l, type, form: applyLegType(l.form, type) } : l
    ));
  }

  function setLegField(idx, key, value) {
    setLegs((prev) => prev.map((l, i) =>
      i === idx ? { ...l, form: { ...l.form, [key]: value } } : l
    ));
  }

  /* ── Combined figures ───────────────────────────────── */
  const totalInvestment = legs.reduce((s, l) => s + n(l.form.investment), 0);
  const bookedPnl       = legs.reduce((s, l) => s + n(l.form.net_booked_pnl), 0);
  const mmPl            = legs.reduce((s, l) => s + n(l.form.market_making_pl), 0);
  const combinedApy     = totalInvestment ? (bookedPnl / totalInvestment) * 365 * 100 : null;

  const upside = {
    byLeg: deriveds.map((d) => ({ opt: n(d.upside_opt_pnl), fut: n(d.upside_fut_pnl), mm: n(d.total_mm_loss), net: n(d.estimated_upside_net_pnl) })),
    opt: deriveds.reduce((s, d) => s + n(d.upside_opt_pnl), 0),
    fut: deriveds.reduce((s, d) => s + n(d.upside_fut_pnl), 0),
    mm:  deriveds.reduce((s, d) => s + n(d.total_mm_loss),  0),
    net: deriveds.reduce((s, d) => s + n(d.estimated_upside_net_pnl), 0),
  };
  const downside = {
    byLeg: deriveds.map((d) => ({ opt: n(d.down_opt_pnl), fut: n(d.downside_fut_pnl), mm: n(d.total_mm_loss), net: n(d.estimated_downside_net_pnl) })),
    opt: deriveds.reduce((s, d) => s + n(d.down_opt_pnl),     0),
    fut: deriveds.reduce((s, d) => s + n(d.downside_fut_pnl), 0),
    mm:  deriveds.reduce((s, d) => s + n(d.total_mm_loss),    0),
    net: deriveds.reduce((s, d) => s + n(d.estimated_downside_net_pnl), 0),
  };

  // BS Today PNL per leg at a target price
  function legBsTodayPnl(form, optType, S_target) {
    const K     = strikeNumber(form.options_strike);
    const ep    = parseFloat(form.opt_entry_price) || 0;
    const qty   = parseFloat(form.opt_entry_qty)   || 0;
    if (!K || !qty) return 0;
    const sigma  = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const expD   = form.expiry ? (() => { const d = new Date(form.expiry); d.setHours(0,0,0,0); return d; })() : null;
    const dte    = expD ? Math.max(0, Math.round((expD - today) / 86400000)) : 0;
    const T      = dte / 365;
    return T > 0
      ? currentPnl(S_target, K, T, RISK_FREE, sigma, optType, ep, qty)
      : expiryPnl(S_target, K, optType, ep, qty);
  }

  const bsUpsideCombined = legs.reduce((s, l) => {
    const S   = parseFloat(l.form.fut_entry_price) || 0;
    const opt = (l.form.option_type || "PUT").toUpperCase();
    return s + legBsTodayPnl(l.form, opt, S + (parseFloat(l.form.upside_distance) || 0));
  }, 0);

  const bsDownsideCombined = legs.reduce((s, l) => {
    const S   = parseFloat(l.form.fut_entry_price) || 0;
    const opt = (l.form.option_type || "PUT").toUpperCase();
    return s + legBsTodayPnl(l.form, opt, S - (parseFloat(l.form.down_distance) || 0));
  }, 0);

  function handleLiveFill(legIdx, { expiry, strike, option_type, opt_entry_price, iv, fut_entry_price, instrument_name, future_instrument }) {
    setLegField(legIdx, "options_strike",  strike);
    setLegField(legIdx, "expiry",          expiry);
    setLegField(legIdx, "option_type",     option_type);
    setLegField(legIdx, "opt_entry_price", opt_entry_price);
    setLegField(legIdx, "iv",              iv);
    setLegField(legIdx, "fut_entry_price", fut_entry_price);
    // Sync leg type badge
    const isCall  = option_type === "CALL";
    const isShort = legs[legIdx]?.type.endsWith("SHORT");
    changeLegType(legIdx, `${isCall ? "CALL" : "PUT"} ${isShort ? "SHORT" : "LONG"}`);
    // Store instrument refs
    const newRefs = [...legInstrumentsRef.current];
    newRefs[legIdx] = { option: instrument_name, future: future_instrument };
    legInstrumentsRef.current = newRefs;
  }

  async function handleExecute() {
    setExecuteError(null); setExecuteResult(null);
    if (!selectedAcct) { setExecuteError("Select an account first."); return; }
    setExecuting(true);
    try {
      const results = [];
      for (let i = 0; i < legs.length; i++) {
        const leg    = legs[i];
        const optQty = parseFloat(leg.form.opt_entry_qty) || 0;
        const futQty = parseFloat(leg.form.fut_qty) || 0;
        const refs   = legInstrumentsRef.current[i] || {};
        const optInst = refs.option || "";
        const futInst = refs.future || `${(leg.form.token || "ETH").toUpperCase()}-PERPETUAL`;

        if (optQty === 0 && futQty === 0) continue;
        if (optQty !== 0 && !optInst) { setExecuteError(`Leg ${i+1}: Use Live Market Data to pick the option instrument.`); setExecuting(false); return; }

        const res  = await fetch("/api/execute", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ account_id: selectedAcct, option_instrument: optQty !== 0 ? optInst : null, option_qty: optQty, future_instrument: futQty !== 0 ? futInst : null, future_qty: futQty }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`Leg ${i+1}: ${data.error || "Execute failed"}`);
        results.push({ leg: i+1, type: leg.type, ...data.results });
      }
      setExecuteResult(results);
    } catch (e) {
      setExecuteError(e.message);
    } finally {
      setExecuting(false);
    }
  }

  /* ── Save handlers ──────────────────────────────────── */
  async function saveStrategies() {
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    try {
      const groupId = `combined_${Date.now()}`;
      const ids = await Promise.all(legs.map((leg) =>
        fetch("/api/options/trades", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...leg.form, group_id: groupId }),
        }).then((r) => r.json()).then((j) => { if (!j.ok && !j.id) throw new Error(j.error || "Save failed"); return j.id; })
      ));
      setSaveMsg(`Saved ${ids.length} legs. Redirecting…`);
      setTimeout(() => router.push("/options"), 1800);
    } catch (err) { setSaveErr(err.message); }
    finally { setSaving(false); }
  }

  async function updateStrategies() {
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    try {
      await Promise.all(legs.map((leg, i) => {
        const id = editIds[i];
        return id
          ? fetch(`/api/options/trades/${id}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...leg.form, group_id: editGroup }),
            }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); })
          : fetch("/api/options/trades", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...leg.form, group_id: editGroup }),
            }).then((r) => r.json()).then((j) => { if (!j.id) throw new Error(j.error || "Save failed"); });
      }));
      setSaveMsg("All strategies updated. Redirecting…");
      setTimeout(() => router.push("/options"), 1500);
    } catch (err) { setSaveErr(err.message); }
    finally { setSaving(false); }
  }

  async function saveAsNewCombined() {
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    try {
      const newGroupId = `combined_${Date.now()}`;
      const ids = await Promise.all(legs.map((leg) => {
        const { id: _id, ...payload } = leg.form;
        return fetch("/api/options/trades", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, group_id: newGroupId }),
        }).then((r) => r.json()).then((j) => { if (!j.id) throw new Error(j.error || "Save failed"); return j.id; });
      }));
      setSaveMsg(`Saved as new combined group (${ids.length} legs). Redirecting…`);
      setTimeout(() => router.push("/options"), 1800);
    } catch (err) { setSaveErr(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-16 items-center gap-3 border-b border-slate-200 bg-white px-6 flex-wrap">
        <button onClick={() => router.back()} className="text-sm text-slate-400 hover:text-slate-700 mr-1">←</button>
        <h1 className="text-xl font-bold text-slate-800">
          {isEditMode ? "Edit Combined Strategy" : "Combined Strategy Simulator"}
        </h1>
        <div className="flex items-center gap-1.5 flex-wrap">
          {legs.map((l, i) => (
            <span key={i} className={`rounded-full px-3 py-0.5 text-xs font-bold border ${LEG_STYLES[l.type].badge}`}>
              {i > 0 && <span className="mr-1.5 text-slate-300">+</span>}{l.type}
            </span>
          ))}
        </div>
        {isEditMode && (
          <span className="ml-auto rounded-full bg-violet-100 px-3 py-0.5 text-xs font-bold text-violet-700">
            Editing group: {editGroup}
          </span>
        )}
      </header>

      {loadErr && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadErr}</div>
      )}

      <div className="p-6 space-y-6">
        {/* ── Leg cards ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {legs.map((leg, idx) => (
            <LegCard
              key={idx}
              label={`Leg ${idx + 1}`}
              legType={leg.type}
              onLegTypeChange={(t) => changeLegType(idx, t)}
              form={leg.form}
              set={(k, v) => setLegField(idx, k, v)}
              derived={deriveds[idx] || {}}
              canRemove={legs.length > 2}
              onRemove={() => removeLeg(idx)}
              accountId={selectedAcct}
              onLiveFill={(data) => handleLiveFill(idx, data)}
            />
          ))}

          {/* Add Leg card */}
          <button onClick={addLeg}
            className="rounded-xl border-2 border-dashed border-teal-200 bg-white hover:border-teal-400 hover:bg-teal-50 transition-colors flex flex-col items-center justify-center gap-3 p-10 min-h-[120px]">
            <span className="h-12 w-12 rounded-full bg-teal-100 flex items-center justify-center">
              <svg className="h-6 w-6 text-teal-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" strokeLinecap="round"/>
              </svg>
            </span>
            <span className="text-sm font-semibold text-teal-700">Add Leg {legs.length + 1}</span>
          </button>
        </div>

        {/* ── Combined Net PnL ── */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-5 text-base font-bold text-slate-800">
            Combined Net PnL
            <span className="ml-2 text-sm font-normal text-slate-400">({legs.map((l) => l.type).join(" + ")})</span>
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <SummaryCard label="Total Investment" value={fmtCcy(totalInvestment)} color="blue" />
            <SummaryCard label="Booked PnL"       value={fmtCcy(bookedPnl)}       color={bookedPnl >= 0 ? "green" : "red"} />
            <SummaryCard label="MM PL"            value={fmtCcy(mmPl)}            color={mmPl >= 0 ? "green" : "red"} />
            <SummaryCard label="Combined APY"     value={combinedApy != null ? `${combinedApy.toFixed(2)}%` : "—"} color="purple" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <ScenarioBlock title="📈 Upside Scenario" legs={legs} perLeg={upside.byLeg} totals={upside} scenario="up" bsToday={bsUpsideCombined} />
            <ScenarioBlock title="📉 Downside Scenario" legs={legs} perLeg={downside.byLeg} totals={downside} scenario="down" bsToday={bsDownsideCombined} />
          </div>

          {/* Side-by-side breakdown table */}
          <div className="mt-6 rounded-lg border border-slate-100 bg-slate-50 p-4 overflow-x-auto">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Side-by-Side Breakdown</p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="py-1.5 pr-4 text-left text-slate-400 font-semibold whitespace-nowrap">Metric</th>
                  {legs.map((l, i) => (
                    <th key={i} className={`py-1.5 px-3 text-right font-bold whitespace-nowrap ${LEG_STYLES[l.type].txt}`}>
                      Leg {i+1} · {l.type}
                    </th>
                  ))}
                  <th className="py-1.5 pl-3 text-right font-bold text-slate-700 whitespace-nowrap">Combined</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Upside Opt PnL",   key: "upside_opt_pnl",            total: upside.opt   },
                  { label: "Down Opt PnL",      key: "down_opt_pnl",              total: downside.opt },
                  { label: "Upside Fut PnL",    key: "upside_fut_pnl",            total: upside.fut   },
                  { label: "Down Fut PnL",      key: "downside_fut_pnl",          total: downside.fut },
                  { label: "MM Loss",           key: "total_mm_loss",             total: upside.mm    },
                  { label: "Est. Net (Up)",     key: "estimated_upside_net_pnl",  total: upside.net,  bold: true },
                  { label: "Est. Net (Down)",   key: "estimated_downside_net_pnl",total: downside.net, bold: true },
                ].map(({ label, key, total, bold }) => (
                  <tr key={key} className="border-b border-dashed border-slate-200">
                    <td className={`py-1.5 pr-4 whitespace-nowrap ${bold ? "font-bold text-slate-700" : "text-slate-400"}`}>{label}</td>
                    {deriveds.map((d, i) => (
                      <td key={i} className={`py-1.5 px-3 text-right font-semibold whitespace-nowrap ${n(d[key]) >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {fmtCcy(d[key])}
                      </td>
                    ))}
                    <td className={`py-1.5 pl-3 text-right font-extrabold whitespace-nowrap ${total >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {fmtCcy(total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Account + Execute ── */}
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/10 p-6 space-y-4">
          <h2 className="text-base font-semibold text-indigo-300">Execute All Legs on Exchange</h2>
          <div className="flex items-center gap-3">
            <select
              value={selectedAcct}
              onChange={e => setSelectedAcct(e.target.value)}
              className="flex-1 rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— Select Account —</option>
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
          <button
            onClick={handleExecute}
            disabled={executing || !selectedAcct}
            className="w-full rounded-xl bg-orange-600 py-3 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-40 transition-colors"
          >
            {executing ? "Placing Orders…" : `⚡ Execute All ${legs.length} Legs (Options + Futures)`}
          </button>
          {executeError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {executeError}
            </div>
          )}
          {executeResult && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 space-y-1">
              <p className="font-semibold">All Legs Executed Successfully</p>
              {executeResult.map((r, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium">Leg {r.leg} ({r.type})</span>
                  {r.option  && <span> · Opt#{r.option?.order?.order_id  ?? "?"}</span>}
                  {r.futures && <span> · Fut#{r.futures?.order?.order_id ?? "?"}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Action buttons ── */}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {isEditMode ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Edit Combined Strategy</h3>
                <p className="text-xs text-slate-400 mt-0.5">Update all legs, or save as a brand-new combined group.</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button onClick={updateStrategies} disabled={saving}
                  className="flex items-center gap-2 rounded-lg bg-violet-600 px-6 py-3 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-60 transition-colors whitespace-nowrap">
                  {saving ? <Spinner /> : <SaveIcon />} Update Strategy
                </button>
                <button onClick={saveAsNewCombined} disabled={saving}
                  className="flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors whitespace-nowrap">
                  {saving ? <Spinner /> : <PlusIcon />} Add as New Strategy
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1">
                <h3 className="text-sm font-bold text-slate-800">Save as Combined Strategy</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Creates {legs.length} records — {legs.map((l, i) => (
                    <span key={i} className={`font-semibold ${LEG_STYLES[l.type].txt}`}>{i > 0 ? " + " : ""}{l.type}</span>
                  ))} — linked together.
                </p>
              </div>
              <button onClick={saveStrategies} disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap">
                {saving ? <Spinner /> : <SaveIcon />} Save All {legs.length} Legs
              </button>
            </div>
          )}

          {saveMsg && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{saveMsg}</div>}
          {saveErr && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{saveErr}</div>}
        </div>
      </div>
    </div>
  );
}

export default function CombinedSimulator() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-400">Loading…</div>}>
      <SimulatorInner />
    </Suspense>
  );
}

/* ── Leg Card ─────────────────────────────────────────── */

function LegCard({ label, legType, onLegTypeChange, form, set, derived, canRemove, onRemove, accountId, onLiveFill }) {
  const inp   = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
  const style = LEG_STYLES[legType];

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 bg-slate-50">
        <span className="text-sm font-bold text-slate-600">{label}</span>
        <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${style.badge}`}>
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          <select value={legType} onChange={(e) => onLegTypeChange(e.target.value)}
            className="bg-transparent text-xs font-bold outline-none cursor-pointer">
            {LEG_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <span className="text-xs text-slate-400 flex-1">
          {legType.endsWith("SHORT") ? "⚠ Negative qty for short" : ""}
        </span>
        {canRemove && (
          <button onClick={onRemove}
            className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-500 hover:bg-red-50 transition-colors">
            Remove
          </button>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Live option picker per leg */}
        {accountId && (
          <LiveOptionPicker
            accountId={accountId}
            token={form.token || "ETH"}
            optionType={form.option_type || (legType.startsWith("CALL") ? "CALL" : "PUT")}
            onFill={onLiveFill}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <F label="Entry Date"><input type="date" value={form.entry_date} onChange={(e) => set("entry_date", e.target.value)} className={inp} /></F>
          <F label="Token"><input type="text" placeholder="BTC, ETH…" value={form.token} onChange={(e) => set("token", e.target.value)} className={inp} /></F>
          <F label="Investment"><input type="number" step="any" value={form.investment} onChange={(e) => set("investment", e.target.value)} className={inp} /></F>
          <F label="Strike"><input type="text" placeholder='e.g. "70 CALL"' value={form.options_strike} onChange={(e) => set("options_strike", e.target.value)} className={inp} /></F>
          <F label="Expiry Date"><input type="date" value={form.expiry} onChange={(e) => set("expiry", e.target.value)} className={inp} /></F>
          <F label={`Entry Qty${legType.endsWith("SHORT") ? " (negative)" : ""}`}>
            <input type="number" step="any" value={form.opt_entry_qty} onChange={(e) => set("opt_entry_qty", e.target.value)}
              className={`${inp} ${legType.endsWith("SHORT") ? "border-orange-300 bg-orange-50" : ""}`} />
          </F>
          <F label="Entry Price"><input type="number" step="any" value={form.opt_entry_price} onChange={(e) => set("opt_entry_price", e.target.value)} className={inp} /></F>
          <F label="Exit Price"><input type="number" step="any" value={form.opt_exit_price} onChange={(e) => set("opt_exit_price", e.target.value)} className={inp} /></F>
          <F label="Fut Qty"><input type="number" step="any" value={form.fut_qty} onChange={(e) => set("fut_qty", e.target.value)} className={inp} /></F>
          <F label="Fut Entry Price"><input type="number" step="any" value={form.fut_entry_price} onChange={(e) => set("fut_entry_price", e.target.value)} className={inp} /></F>
          <F label="Fut Exit Price"><input type="number" step="any" value={form.fut_exit_price} onChange={(e) => set("fut_exit_price", e.target.value)} className={inp} /></F>
          <F label="IV (%) for BS"><input type="number" step="0.5" min="1" max="500" placeholder="e.g. 30" value={form.iv} onChange={(e) => set("iv", e.target.value)} className={`${inp} border-indigo-200 bg-indigo-50`} /></F>
          <F label="Upside Distance"><input type="number" step="any" value={form.upside_distance} onChange={(e) => set("upside_distance", e.target.value)} className={inp} /></F>
          <F label="Down Distance"><input type="number" step="any" value={form.down_distance} onChange={(e) => set("down_distance", e.target.value)} className={inp} /></F>
          <F label="Basket Distance"><input type="number" step="any" value={form.basket_distance} onChange={(e) => set("basket_distance", e.target.value)} className={inp} /></F>
          <F label="Basket Loss"><input type="number" step="any" value={form.basket_loss} onChange={(e) => set("basket_loss", e.target.value)} className={inp} /></F>
          <F label="Net Booked PnL"><input type="number" step="any" value={form.net_booked_pnl} onChange={(e) => set("net_booked_pnl", e.target.value)} className={inp} /></F>
          <F label="Market Making PL"><input type="number" step="any" value={form.market_making_pl} onChange={(e) => set("market_making_pl", e.target.value)} className={inp} /></F>
          <F label="Status">
            <select value={form.status} onChange={(e) => set("status", e.target.value)} className={inp}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </F>
          <F label="End Date"><input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className={inp} /></F>
        </div>

        {/* Live calc strip */}
        <div className="rounded-lg bg-slate-50 border border-slate-100 p-4 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Auto-Calculated</p>
          <CalcRow label="Days to Expiry"    value={fmt(derived.days_to_expiry, "n")} />
          <CalcRow label="Total Theta"       value={fmt(derived.total_theta_gain_loss)} signed />
          <CalcRow label="Per Day Theta"     value={fmt(derived.per_day_theta_gain_loss)} signed />
          <CalcRow label="Total Baskets"     value={fmt(derived.total_baskets, "n")} />
          <CalcRow label="Total MM Loss"     value={fmt(derived.total_mm_loss)} neg />
          <div className="my-2 border-t border-slate-200" />
          <CalcRow label="Upper Limit"       value={fmt(derived.upper_limit, "n")} />
          <CalcRow label="Lower Limit"       value={fmt(derived.lower_limit, "n")} />
          <div className="my-2 border-t border-slate-200" />
          <CalcRow label="Opt PnL (Upside)"  value={fmt(derived.upside_opt_pnl)} signed />
          <CalcRow label="Fut PnL (Upside)"  value={fmt(derived.upside_fut_pnl)} signed />
          <div className="my-2 border-t border-slate-200" />
          <CalcRow label="Opt PnL (Down)"    value={fmt(derived.down_opt_pnl)} signed />
          <CalcRow label="Fut PnL (Down)"    value={fmt(derived.downside_fut_pnl)} signed />
          <div className="my-2 border-t border-slate-200" />
          <CalcRow label="APY"               value={derived.apy != null ? `${Number(derived.apy).toFixed(2)}%` : "—"} signed big />
          <BsStrip form={form} legType={legType} derived={derived} />
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────── */

function F({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      {children}
    </div>
  );
}

function CalcRow({ label, value, signed, neg, big }) {
  const raw   = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(raw);
  const color = neg ? "text-red-600"
    : signed && isNum && raw < 0  ? "text-red-600"
    : signed && isNum && raw >= 0 ? "text-emerald-600"
    : "text-slate-700";
  return (
    <div className={`flex items-center justify-between ${big ? "py-1" : ""}`}>
      <span className={big ? "text-sm font-bold text-slate-700" : "text-xs text-slate-400"}>{label}</span>
      <span className={`${big ? "text-base font-extrabold" : "text-xs font-semibold"} ${color}`}>{value ?? "—"}</span>
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  const cls = { blue:"text-blue-600", green:"text-emerald-600", red:"text-red-600", purple:"text-purple-600" }[color] || "text-slate-700";
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
      <p className="text-xs font-medium text-slate-400 mb-1">{label}</p>
      <p className={`text-xl font-bold ${cls}`}>{value}</p>
    </div>
  );
}

function ScenarioBlock({ title, legs, perLeg, totals, scenario, bsToday }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
      <p className="text-xs font-bold text-slate-700 mb-3">{title}</p>
      {legs.map((l, i) => (
        <div key={i} className="flex justify-between py-1.5 border-b border-dashed border-slate-200">
          <span className={`text-xs ${LEG_STYLES[l.type].txt} font-semibold`}>Opt PnL — Leg {i+1} ({l.type})</span>
          <span className={`text-xs font-semibold ${perLeg[i]?.opt >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            {fmtCcy(perLeg[i]?.opt)}
          </span>
        </div>
      ))}
      <div className="flex justify-between py-1.5 border-b border-dashed border-slate-200">
        <span className="text-xs text-slate-400">Fut PnL (combined)</span>
        <span className={`text-xs font-semibold ${totals.fut >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(totals.fut)}</span>
      </div>
      <div className="flex justify-between py-1.5 border-b border-dashed border-slate-200">
        <span className="text-xs text-slate-400">Total MM Loss</span>
        <span className={`text-xs font-semibold ${totals.mm >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(totals.mm)}</span>
      </div>
      <div className="flex justify-between pt-3 pb-1 border-b border-slate-200">
        <span className="text-sm font-bold text-slate-700">Est. Net {scenario === "up" ? "Upside" : "Downside"}</span>
        <span className={`text-base font-extrabold ${totals.net >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(totals.net)}</span>
      </div>
      <div className="flex justify-between pt-2 pb-1">
        <span className="text-sm font-bold text-indigo-700">Today BS {scenario === "up" ? "Upside" : "Downside"}</span>
        <span className={`text-base font-extrabold ${bsToday >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(bsToday)}</span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round"/>
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" strokeLinejoin="round"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 8v8M8 12h8" strokeLinecap="round"/>
    </svg>
  );
}

/* ── BS Strip (per-leg Black-Scholes PNL preview) ───── */

function BsStrip({ form, legType, derived }) {
  const K_bs      = strikeNumber(form.options_strike);
  const ep_bs     = parseFloat(form.opt_entry_price) || 0;
  const qty_bs    = parseFloat(form.opt_entry_qty)   || 0;
  const S_bs      = parseFloat(form.fut_entry_price) || K_bs || 0;
  const sigma_bs  = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
  const optType_bs = (form.option_type || (legType.startsWith("CALL") ? "CALL" : "PUT")).toUpperCase();
  const today_d   = new Date(); today_d.setHours(0, 0, 0, 0);
  const expiry_d  = form.expiry ? (() => { const d = new Date(form.expiry); d.setHours(0,0,0,0); return d; })() : null;
  const dte_bs    = expiry_d ? Math.max(0, Math.round((expiry_d - today_d) / 86400000)) : 0;
  const T_bs      = dte_bs / 365;
  const S_up_bs   = S_bs + (parseFloat(form.upside_distance) || 0);
  const S_dn_bs   = S_bs - (parseFloat(form.down_distance)   || 0);
  const hasBS     = K_bs > 0 && qty_bs !== 0;

  const bsUp        = hasBS ? expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs) : null;
  const bsDn        = hasBS ? expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs) : null;
  const bsUpToday   = hasBS && S_up_bs > 0
    ? (T_bs > 0 ? currentPnl(S_up_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsDnToday   = hasBS && S_dn_bs > 0
    ? (T_bs > 0 ? currentPnl(S_dn_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsToday     = hasBS && S_bs > 0
    ? (T_bs > 0 ? currentPnl(S_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_bs, K_bs, optType_bs, ep_bs, qty_bs))
    : null;
  const bsBE = K_bs > 0 ? (optType_bs === "CALL" ? K_bs + ep_bs : K_bs - ep_bs) : null;

  return (
    <>
      <div className="my-2 border-t border-indigo-200" />
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400 mb-1">
        📊 BS Option PNL (IV {form.iv || 30}%, {dte_bs}d)
      </p>
      {(() => {
        const futUp = Number(derived?.upside_fut_pnl)   || 0;
        const futDn = Number(derived?.downside_fut_pnl) || 0;
        const mm    = Number(derived?.total_mm_loss)    || 0;
        const netUpToday  = bsUpToday != null ? bsUpToday + futUp + mm : null;
        const netDnToday  = bsDnToday != null ? bsDnToday + futDn + mm : null;
        const netUpExpiry = bsUp      != null ? bsUp      + futUp + mm : null;
        const netDnExpiry = bsDn      != null ? bsDn      + futDn + mm : null;
        return (
          <>
            <CalcRow label="Upside Opt (Today BS)"     value={fmt(bsUpToday)}   signed />
            <CalcRow label="Downside Opt (Today BS)"   value={fmt(bsDnToday)}   signed />
            <CalcRow label="Upside Opt (Expiry)"       value={fmt(bsUp)}        signed />
            <CalcRow label="Downside Opt (Expiry)"     value={fmt(bsDn)}        signed />
            <CalcRow label="Fut PnL (Upside)"          value={fmt(futUp)}       signed />
            <CalcRow label="Fut PnL (Downside)"        value={fmt(futDn)}       signed />
            <CalcRow label="Total MM Loss"             value={fmt(mm)}          neg />
            <CalcRow label="Net BS Upside (Today)"     value={fmt(netUpToday)}  signed big />
            <CalcRow label="Net BS Downside (Today)"   value={fmt(netDnToday)}  signed big />
            <CalcRow label="Est Net Upside (Expiry)"   value={fmt(netUpExpiry)} signed big />
            <CalcRow label="Est Net Downside (Expiry)" value={fmt(netDnExpiry)} signed big />
            <CalcRow label="At Current Price (Today BS)" value={fmt(bsToday)}   signed big />
            <CalcRow label="Breakeven"
              value={bsBE != null ? bsBE.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} />
          </>
        );
      })()}
    </>
  );
}

function BsSimRow({ label, value, signed }) {
  const raw   = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(raw);
  const color = signed && isNum ? (raw >= 0 ? "text-emerald-600" : "text-red-600") : "text-slate-700";
  return (
    <div className="py-1 border-b border-dashed border-slate-100">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value ?? "—"}</div>
    </div>
  );
}

/* ── Formatters ──────────────────────────────────────── */

function fmtCcy(v) {
  const num = Number(v);
  if (v === null || v === undefined || isNaN(num)) return "—";
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmt(v, type) {
  const num = Number(v);
  if (v === null || v === undefined || isNaN(num)) return "—";
  if (type === "n") return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

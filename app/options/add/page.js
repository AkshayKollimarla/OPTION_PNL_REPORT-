"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { computeDerived, strikeNumber } from "../../../lib/options-calculations";
import { expiryPnl, currentPnl } from "../../../lib/black-scholes";

const RISK_FREE = 0.05;
const KNOWN_TOKENS = ["ETH", "BTC", "SOL_USDC", "XRP_USDC"];

const EMPTY = {
  entry_date:"", token:"", option_type:"PUT", investment:"", options_strike:"", expiry:"",
  opt_entry_qty:"", opt_entry_price:"", opt_exit_price:"", iv:"",
  fut_qty:"", fut_entry_price:"", fut_exit_price:"", fut_instrument_type:"inverse",
  upside_distance:"", down_distance:"", basket_distance:"", basket_loss:"",
  net_booked_pnl:"", market_making_pl:"", end_date:"", status:"open",
};

// Build Deribit instrument name from parts
function buildDeribitInst(token, expiry, strike, optType) {
  if (!token || !expiry || !strike) return null;
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(expiry + "T00:00:00Z");
  if (isNaN(d)) return null;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = MONTHS[d.getUTCMonth()];
  const yr  = String(d.getUTCFullYear()).slice(-2);
  return `${token.toUpperCase()}-${day}${mon}${yr}-${strike}-${optType === "CALL" ? "C" : "P"}`;
}

// BTC and ETH have both an inverse perpetual (BTC-PERPETUAL, coin-margined)
// and a USDC-margined linear perpetual (BTC_USDC-PERPETUAL) on Deribit.
// Tokens that are already USDC-linear (SOL_USDC, XRP_USDC, ...) only have
// one form — the token itself already encodes it, so futType is ignored.
function futuresHasBothTypes(token) {
  const coin = (token || "").toUpperCase().replace(/_USDC$|_USDT$/, "");
  return coin === "BTC" || coin === "ETH";
}
function buildFuturesInst(token, futType) {
  const t = (token || "ETH").toUpperCase();
  if (!futuresHasBothTypes(t)) return `${t}-PERPETUAL`;
  const coin = t.replace(/_USDC$|_USDT$/, "");
  return futType === "linear" ? `${coin}_USDC-PERPETUAL` : `${coin}-PERPETUAL`;
}

export default function AddStrategy({ initialData, tradeId, isEdit }) {
  const router = useRouter();

  // Form state
  const [form,    setForm]    = useState(initialData || EMPTY);
  const [derived, setDerived] = useState({});
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState(null);
  const [success, setSuccess] = useState(null);

  // Account state — restore the saved account when editing, instead of
  // defaulting to "manual entry" and losing the trade's account link.
  const [accounts,      setAccounts]      = useState([]);
  const [selectedAcct,  setSelectedAcct]  = useState(initialData?.account_id ? String(initialData.account_id) : "");

  // Live market data state
  const [liveExpiries,   setLiveExpiries]   = useState([]); // [{date, label, strikes[]}]
  const [loadingChain,   setLoadingChain]   = useState(false);
  const [tickerInfo,     setTickerInfo]     = useState(null);
  const [fetchingTicker, setFetchingTicker] = useState(false);
  const chainTimerRef = useRef(null);

  // Guards the live-chain/ticker auto-fill effects from clobbering saved
  // expiry/strike/prices when editing a strategy that already has data —
  // cleared the moment the user explicitly changes token/expiry/strike.
  const preserveRef = useRef(!!(isEdit && initialData?.expiry));

  // Token field: dropdown of known tokens, or manual free-text entry for
  // anything else (e.g. DOGE_USDC, MATIC, AVAX_USDC). Starts in manual mode
  // when editing a strategy whose saved token isn't one of the known ones.
  const [manualToken, setManualToken] = useState(() => !!(initialData?.token && !KNOWN_TOKENS.includes(initialData.token)));

  // Mid prices for maker limit orders
  const [optMidPriceRaw, setOptMidPriceRaw] = useState(0);
  const [futMidPrice,    setFutMidPrice]    = useState(0);

  // Execute state
  const [executing,     setExecuting]     = useState(false);
  const [executeResult, setExecuteResult] = useState(null);
  const [executeError,  setExecuteError]  = useState(null);

  // Smart entry engine state
  const [entryPhase, setEntryPhase] = useState("idle"); // idle|option_pending|futures_pending|done|error
  const [entryLogs,  setEntryLogs]  = useState([]);
  const entryTimerRef = useRef(null);
  const entryStateRef = useRef({
    phase: "idle", accountId: "", token: "",
    optInst: "", optQty: 0, optDir: "buy",
    futInst: "", futQty: 0, futDir: "buy",
    orderId: null, orderMid: 0,
  });
  // Set by the combined "Execute + Auto-Close" button — the moment entry
  // finishes filling, auto-close starts immediately (no manual second click,
  // no gap where the price/PnL can drift before the initial snapshot freezes).
  const [autoCloseAfterEntry, setAutoCloseAfterEntry] = useState(false);

  // Auto-close state — drives a server-side job (lib/auto-close-worker.js) so
  // it keeps running even if this tab closes. No client-side execution engine.
  const [acTargetPnl, setAcTargetPnl] = useState("");
  const [acJob,        setAcJob]      = useState(null); // full row from /api/auto-close?id=X
  const [acStarting,   setAcStarting] = useState(false);
  const [acError,      setAcError]    = useState(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [editTargetValue, setEditTargetValue] = useState("");
  const acTimerRef = useRef(null);

  // ── Effects ──────────────────────────────────────────────
  useEffect(() => { setDerived(computeDerived(form)); }, [form]);

  useEffect(() => {
    fetch("/api/accounts").then(r => r.json()).then(d => setAccounts(d.accounts || [])).catch(() => {});
  }, []);

  // Load option chain when account + token changes (debounced 700ms)
  useEffect(() => {
    clearTimeout(chainTimerRef.current);
    if (!selectedAcct || !form.token || form.token.trim().length < 2) {
      setLiveExpiries([]);
      setTickerInfo(null);
      return;
    }
    chainTimerRef.current = setTimeout(async () => {
      const token = form.token.trim().toUpperCase();
      setLoadingChain(true);
      setLiveExpiries([]);
      setTickerInfo(null);
      try {
        const res  = await fetch(`/api/market?account_id=${selectedAcct}&token=${token}&action=chain`);
        const data = await res.json();
        if (res.ok && data.expiries?.length) {
          setLiveExpiries(data.expiries);
          if (preserveRef.current) {
            // Editing a saved strategy — leave expiry, strike, and futures
            // price exactly as saved. Only the expiry/strike dropdowns
            // become available (so the user CAN switch), nothing is fetched
            // or displayed automatically until they refresh or change a field.
          } else {
            // Auto-select first expiry
            setForm(f => ({ ...f, expiry: data.expiries[0].date, options_strike: "" }));
            // Auto-fill futures price
            fetch(`/api/market?account_id=${selectedAcct}&token=${token}&action=futures&instrument=${encodeURIComponent(buildFuturesInst(token, form.fut_instrument_type))}`)
              .then(r => r.json())
              .then(d => {
                if (d.mark_price) {
                  setFutMidPrice(d.mid_price ?? d.mark_price ?? 0);
                  setForm(f => ({ ...f, fut_entry_price: String(d.mark_price) }));
                }
              })
              .catch(() => {});
          }
        }
      } finally {
        setLoadingChain(false);
      }
    }, 700);
    return () => clearTimeout(chainTimerRef.current);
  }, [selectedAcct, form.token]);

  // Auto-fetch ticker when expiry/strike/option_type changes (live mode only).
  // Skipped entirely while preserving saved data — no live price should even
  // be fetched/displayed next to the saved entry price until the user
  // explicitly refreshes or changes token/expiry/strike.
  useEffect(() => {
    if (preserveRef.current) return;
    if (!selectedAcct || !liveExpiries.length || !form.options_strike || !form.expiry) {
      return;
    }
    const inst  = buildDeribitInst(form.token, form.expiry, form.options_strike, form.option_type);
    const token = (form.token || "ETH").toUpperCase();
    if (!inst) return;
    let cancelled = false;
    setFetchingTicker(true);
    setTickerInfo(null);
    fetch(`/api/market?account_id=${selectedAcct}&token=${token}&action=ticker&instrument=${encodeURIComponent(inst)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data.mark_price_usd) return;
        setTickerInfo({ ...data, instrument: inst });
        setOptMidPriceRaw(data.mid_price_raw ?? data.mark_price_raw ?? 0);
        setForm(f => ({
          ...f,
          opt_entry_price: data.mark_price_usd.toFixed(4),
          iv: data.mark_iv != null ? String(Math.round(data.mark_iv * 10) / 10) : f.iv,
        }));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setFetchingTicker(false); });
    return () => { cancelled = true; };
  }, [form.expiry, form.options_strike, form.option_type, selectedAcct, liveExpiries.length]);

  // Cleanup intervals on unmount
  useEffect(() => { return () => { clearInterval(acTimerRef.current); clearInterval(entryTimerRef.current); }; }, []);

  // Resume polling if a server auto-close job is already active for this trade
  useEffect(() => {
    if (!isEdit || !tradeId) return;
    fetch(`/api/auto-close?trade_id=${tradeId}`).then(r => r.json()).then(d => {
      const activeJob = (d.jobs || []).find(j => ["active","closing_option","closing_futures"].includes(j.status));
      if (activeJob) {
        clearInterval(acTimerRef.current);
        pollAcJob(activeJob.id);
        acTimerRef.current = setInterval(() => pollAcJob(activeJob.id), 5000);
      }
    }).catch(() => {});
  }, [isEdit, tradeId]);

  // Combined "Execute + Auto-Close" flow — the instant the entry engine
  // reports "done", immediately start the auto-close job so the initial
  // collateral snapshot is taken right against the fresh position, not
  // minutes later after a separate manual click.
  useEffect(() => {
    if (entryPhase === "done" && autoCloseAfterEntry) {
      setAutoCloseAfterEntry(false);
      startAutoClose();
    }
    if (entryPhase === "error" && autoCloseAfterEntry) {
      setAutoCloseAfterEntry(false); // entry failed — don't start a monitor for a position that doesn't exist
    }
  }, [entryPhase, autoCloseAfterEntry]);

  // ── Helpers ───────────────────────────────────────────────
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function refreshTicker() {
    preserveRef.current = false;
    const inst  = buildDeribitInst(form.token, form.expiry, form.options_strike, form.option_type);
    const token = (form.token || "ETH").toUpperCase();
    if (!inst || !selectedAcct) return;
    setFetchingTicker(true);
    try {
      const [optRes, futRes] = await Promise.all([
        fetch(`/api/market?account_id=${selectedAcct}&token=${token}&action=ticker&instrument=${encodeURIComponent(inst)}`),
        fetch(`/api/market?account_id=${selectedAcct}&token=${token}&action=futures&instrument=${encodeURIComponent(buildFuturesInst(token, form.fut_instrument_type))}`),
      ]);
      const [optData, futData] = await Promise.all([optRes.json(), futRes.json()]);

      if (optRes.ok && optData.mark_price_usd != null) {
        setTickerInfo({ ...optData, instrument: inst });
        setOptMidPriceRaw(optData.mid_price_raw ?? optData.mark_price_raw ?? 0);
        setForm(f => ({
          ...f,
          opt_entry_price: optData.mark_price_usd.toFixed(4),
          iv: optData.mark_iv != null ? String(Math.round(optData.mark_iv * 10) / 10) : f.iv,
        }));
      }

      if (futRes.ok && futData.mark_price != null) {
        setFutMidPrice(futData.mid_price ?? futData.mark_price ?? 0);
        setForm(f => ({ ...f, fut_entry_price: String(Math.round(futData.mark_price * 100) / 100) }));
      }
    } finally {
      setFetchingTicker(false);
    }
  }

  // ── Smart Entry Engine ────────────────────────────────────
  function addEntryLog(msg) {
    const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
    setEntryLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  }

  async function triggerFuturesEntry(st) {
    clearInterval(entryTimerRef.current);
    setEntryPhase("futures_pending");
    entryStateRef.current = { ...entryStateRef.current, phase: "futures_pending" };
    if (!st.futInst || !st.futQty) {
      addEntryLog("No futures — done.");
      setEntryPhase("done");
      entryStateRef.current = { ...entryStateRef.current, phase: "done" };
      return;
    }
    addEntryLog(`Placing futures MARKET ${st.futDir} ${Math.abs(st.futQty)}x ${st.futInst}`);
    const res = await fetch("/api/deribit-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: st.accountId, instrument: st.futInst, qty: Math.abs(st.futQty), direction: st.futDir, is_market: true }),
    });
    const data = await res.json();
    if (!res.ok) { addEntryLog(`Futures failed: ${data.error}`); setEntryPhase("error"); entryStateRef.current = { ...entryStateRef.current, phase: "error" }; return; }
    addEntryLog(`Futures filled @ ${data.price ?? "market"}`);
    setEntryPhase("done");
    entryStateRef.current = { ...entryStateRef.current, phase: "done" };
  }

  async function placeOptionEntry(st, midPrice) {
    addEntryLog(`Placing ${st.optDir} ${Math.abs(st.optQty)}x ${st.optInst} @ mid ${midPrice.toFixed(5)}`);
    const res = await fetch("/api/deribit-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: st.accountId, instrument: st.optInst, qty: Math.abs(st.optQty), direction: st.optDir, price: midPrice, is_market: false, post_only: false }),
    });
    const data = await res.json();
    if (!res.ok || !data.order_id) {
      addEntryLog(`Option order failed: ${data.error}`);
      clearInterval(entryTimerRef.current);
      entryStateRef.current = { ...entryStateRef.current, phase: "error" };
      setEntryPhase("error");
      return;
    }
    entryStateRef.current = { ...entryStateRef.current, orderId: data.order_id, orderMid: midPrice };
    addEntryLog(`Order #${data.order_id.slice(-8)} — ${data.order_state}`);
    if (data.order_state === "filled") {
      addEntryLog("Option filled immediately!");
      await triggerFuturesEntry({ ...entryStateRef.current, phase: "futures_pending" });
    }
  }

  async function entryPollTick() {
    const st = entryStateRef.current;
    if (st.phase !== "option_pending" || !st.orderId) return;
    try {
      const stRes  = await fetch(`/api/deribit-order?account_id=${st.accountId}&order_id=${st.orderId}`);
      const stData = await stRes.json();
      if (stData.order_state === "filled") {
        addEntryLog("Option filled!");
        await triggerFuturesEntry({ ...st, phase: "futures_pending" });
        return;
      }
      // Check if mid price moved enough to re-place
      const tickRes  = await fetch(`/api/market?account_id=${st.accountId}&token=${st.token}&action=ticker&instrument=${encodeURIComponent(st.optInst)}`);
      const tickData = await tickRes.json();
      const newMid   = tickData.mid_price_raw ?? 0;
      if (newMid > 0 && Math.abs(newMid - st.orderMid) > 0.00005) {
        addEntryLog(`Mid ${st.orderMid.toFixed(5)} → ${newMid.toFixed(5)}, re-placing`);
        await fetch(`/api/deribit-order?account_id=${st.accountId}&order_id=${st.orderId}`, { method: "DELETE" });
        await placeOptionEntry(st, newMid);
      } else {
        addEntryLog(`Waiting — order open @ ${st.orderMid.toFixed(5)}`);
      }
    } catch (e) { addEntryLog(`Poll error: ${e.message}`); }
  }

  function cancelEntryOrder() {
    clearInterval(entryTimerRef.current);
    const st = entryStateRef.current;
    if (st.orderId && st.accountId) {
      fetch(`/api/deribit-order?account_id=${st.accountId}&order_id=${st.orderId}`, { method: "DELETE" }).catch(() => {});
    }
    addEntryLog("Order cancelled by user.");
    entryStateRef.current = { ...entryStateRef.current, phase: "idle" };
    setEntryPhase("idle");
  }

  async function handleExecute() {
    setExecuteError(null); setExecuteResult(null); setEntryLogs([]);
    if (!selectedAcct) { setExecuteError("Select an account first."); return; }
    const optQty = parseFloat(form.opt_entry_qty) || 0;
    const futQty = parseFloat(form.fut_qty) || 0;
    if (optQty === 0 && futQty === 0) { setExecuteError("Enter option qty and/or futures qty."); return; }
    const optInst = buildDeribitInst(form.token, form.expiry, form.options_strike, form.option_type);
    const futInst = buildFuturesInst(form.token, form.fut_instrument_type);
    if (optQty !== 0 && !optInst) { setExecuteError("Select expiry and strike."); return; }
    if (optQty !== 0 && form.expiry) {
      const today      = new Date(); today.setUTCHours(0, 0, 0, 0);
      const expiryDate = new Date(form.expiry + "T00:00:00Z");
      if (expiryDate < today) {
        setExecuteError(`${optInst} expired on ${form.expiry} and can no longer be traded. Pick a current expiry/strike before executing.`);
        return;
      }
    }
    setExecuting(true);
    setEntryPhase(optQty !== 0 ? "option_pending" : "futures_pending");
    try {
      const currency = (form.token || "ETH").toUpperCase();
      // Freeze balance (non-blocking)
      fetch(`/api/balance?account_id=${selectedAcct}&currency=${currency}`).then(r => r.json())
        .then(d => { if (d.equity != null) setForm(f => ({ ...f, investment: String(d.equity) })); }).catch(() => {});

      // Futures-only path: immediate market order
      if (optQty === 0) {
        const dir = futQty > 0 ? "buy" : "sell";
        addEntryLog(`Placing futures MARKET ${dir} ${Math.abs(futQty)}x ${futInst}`);
        const res  = await fetch("/api/deribit-order", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: selectedAcct, instrument: futInst, qty: Math.abs(futQty), direction: dir, is_market: true }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Futures order failed");
        addEntryLog(`Futures filled @ ${data.price ?? "market"}`);
        setEntryPhase("done");
        return;
      }

      // Fetch fresh option mid price
      const tickRes  = await fetch(`/api/market?account_id=${selectedAcct}&token=${currency}&action=ticker&instrument=${encodeURIComponent(optInst)}`);
      const tickData = await tickRes.json();
      const initialMid = tickData.mid_price_raw ?? 0;
      if (!initialMid) throw new Error("Could not get option mid price");
      setOptMidPriceRaw(initialMid);

      entryStateRef.current = {
        phase: "option_pending", accountId: selectedAcct, token: currency,
        optInst, optQty, optDir: optQty > 0 ? "buy" : "sell",
        futInst, futQty, futDir: futQty > 0 ? "buy" : "sell",
        orderId: null, orderMid: 0,
      };

      await placeOptionEntry(entryStateRef.current, initialMid);

      // Start 5-second polling if option still open
      if (entryStateRef.current.phase === "option_pending") {
        clearInterval(entryTimerRef.current);
        entryTimerRef.current = setInterval(entryPollTick, 5000);
      }
    } catch (e) {
      setExecuteError(e.message);
      setEntryPhase("error");
      clearInterval(entryTimerRef.current);
    } finally {
      setExecuting(false);
    }
  }

  // Combined button: validates the target up front, then runs the normal
  // entry flow — the effect above fires startAutoClose() the instant entry
  // reports "done", so there's no manual second click and no window for the
  // price/PnL to drift before the initial collateral snapshot is taken.
  async function handleExecuteAndAutoClose() {
    if (!(parseFloat(acTargetPnl) > 0)) { setAcError("Enter a Booking PnL Target first."); return; }
    setAcError(null);
    setAutoCloseAfterEntry(true);
    await handleExecute();
  }

  // ── Auto-Close (server-side job) ────────────────────────────
  async function pollAcJob(jobId) {
    try {
      const r = await fetch(`/api/auto-close?id=${jobId}`);
      const d = await r.json();
      if (d.job) {
        setAcJob(d.job);
        if (["completed","failed","stopped"].includes(d.job.status)) {
          clearInterval(acTimerRef.current);
        }
      }
    } catch {}
  }

  async function startAutoClose() {
    setAcError(null);
    const optQty      = parseFloat(form.opt_entry_qty) || 0;
    const futQty      = parseFloat(form.fut_qty) || 0;
    const totalOptQty = Math.abs(optQty);
    const totalFutQty = Math.abs(futQty);
    const token        = (form.token || "ETH").toUpperCase();
    const optInst       = buildDeribitInst(form.token, form.expiry, form.options_strike, form.option_type);
    const futInst       = totalFutQty > 0 ? buildFuturesInst(form.token, form.fut_instrument_type) : "";
    const tPnl          = parseFloat(acTargetPnl) || 0;

    if (!selectedAcct)            { setAcError("Select an account first."); return; }
    if (!optInst || !totalOptQty) { setAcError("No option position configured."); return; }
    if (tPnl <= 0)                { setAcError("Enter a target PnL > 0."); return; }

    setAcStarting(true);
    try {
      const bal = await fetch(`/api/balance?account_id=${selectedAcct}&mode=collateral&token=${token}`).then(r => r.json());
      if (bal.error) throw new Error(bal.error);

      const res = await fetch("/api/auto-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trade_id:          tradeId || null,
          account_id:        selectedAcct,
          token,
          opt_instrument:    optInst,
          opt_qty:           totalOptQty,
          opt_dir:           optQty > 0 ? "sell" : "buy",
          opt_entry_price:   form.opt_entry_price || null,
          fut_instrument:    futInst,
          fut_qty:           totalFutQty,
          fut_dir:           futQty > 0 ? "sell" : "buy",
          fut_entry_price:   form.fut_entry_price || null,
          initial_total_usd: bal.total_usd ?? 0,
          target_pnl:        tPnl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start auto-close job");

      clearInterval(acTimerRef.current);
      pollAcJob(data.id);
      acTimerRef.current = setInterval(() => pollAcJob(data.id), 5000);
    } catch (e) {
      setAcError(e.message);
    } finally {
      setAcStarting(false);
    }
  }

  async function stopAutoClose() {
    if (!acJob?.id) return;
    try {
      await fetch(`/api/auto-close?id=${acJob.id}`, { method: "DELETE" });
      pollAcJob(acJob.id);
    } catch (e) { setAcError(e.message); }
  }

  async function editAutoCloseTarget() {
    if (!acJob?.id) return;
    const newTarget = parseFloat(editTargetValue);
    if (!(newTarget > 0)) { setAcError("Enter a target PnL > 0."); return; }
    setAcStarting(true);
    try {
      const res  = await fetch(`/api/auto-close?id=${acJob.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_pnl: newTarget }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update target");
      setEditingTarget(false);
      pollAcJob(acJob.id);
    } catch (e) { setAcError(e.message); }
    finally { setAcStarting(false); }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true); setError(null); setSuccess(null);
    try {
      const allLogs = [...entryLogs, ...(acJob?.logs || [])].filter(Boolean).slice(0, 300);
      const payload = {
        ...form,
        execution_log:          allLogs.length ? JSON.stringify(allLogs) : undefined,
        target_pnl:             parseFloat(acTargetPnl) > 0 ? parseFloat(acTargetPnl) : undefined,
        initial_collateral_usd: acJob?.initial_total_usd > 0 ? acJob.initial_total_usd : undefined,
        account_id:             selectedAcct || undefined,
      };
      const url    = isEdit ? `/api/options/trades/${tradeId}` : "/api/options/trades";
      const method = isEdit ? "PUT" : "POST";
      const res    = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
      const allLogs = [...entryLogs, ...(acJob?.logs || [])].filter(Boolean).slice(0, 300);
      const { group_id, id, ...base } = form;
      const payload = {
        ...base,
        execution_log:          allLogs.length ? JSON.stringify(allLogs) : undefined,
        target_pnl:             parseFloat(acTargetPnl) > 0 ? parseFloat(acTargetPnl) : undefined,
        initial_collateral_usd: acJob?.initial_total_usd > 0 ? acJob.initial_total_usd : undefined,
        account_id:             selectedAcct || undefined,
      };
      const res  = await fetch("/api/options/trades", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSuccess(`Saved as new strategy #${json.id}. Redirecting…`);
      setTimeout(() => router.push(`/options/edit/${json.id}`), 1200);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  // ── Derived / live data helpers ───────────────────────────
  const liveExpiryObj = liveExpiries.find(e => e.date === form.expiry) || null;
  const liveStrikes   = liveExpiryObj?.strikes || [];
  const hasLiveData   = liveExpiries.length > 0;
  const currentInst   = hasLiveData
    ? buildDeribitInst(form.token, form.expiry, form.options_strike, form.option_type)
    : null;
  const isExpired = !!(form.expiry && (() => {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    return new Date(form.expiry + "T00:00:00Z") < today;
  })());

  // ── Black-Scholes ─────────────────────────────────────────
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
                : expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsDownTodayPnl   = hasBS && S_dn_bs > 0
    ? (T_bs > 0 ? currentPnl(S_dn_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsTodayPnl       = hasBS && S_bs > 0
    ? (T_bs > 0 ? currentPnl(S_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsBreakeven = K_bs > 0 ? (optType_bs === "CALL" ? K_bs + ep_bs : K_bs - ep_bs) : null;
  const futUp_bs  = Number(derived.upside_fut_pnl)   || 0;
  const futDn_bs  = Number(derived.downside_fut_pnl) || 0;
  const mm_bs     = Number(derived.total_mm_loss)    || 0;
  const bsNetUpsideToday   = bsUpsideTodayPnl != null ? bsUpsideTodayPnl + futUp_bs + mm_bs : null;
  const bsNetDownToday     = bsDownTodayPnl   != null ? bsDownTodayPnl   + futDn_bs + mm_bs : null;
  const bsNetUpsideExpiry  = bsUpsidePnl      != null ? bsUpsidePnl      + futUp_bs + mm_bs : null;
  const bsNetDownExpiry    = bsDownPnl        != null ? bsDownPnl        + futDn_bs + mm_bs : null;

  // ── Render ────────────────────────────────────────────────
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
        {/* LEFT: input form */}
        <form onSubmit={onSubmit} className="xl:col-span-2 space-y-6">
          {error   && <Alert type="error">{error}</Alert>}
          {success && <Alert type="ok">{success}</Alert>}

          {/* ── Account bar ── */}
          <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-5 py-3 shadow-card flex-wrap">
            <label className="text-sm font-semibold text-slate-600 whitespace-nowrap">Exchange Account</label>
            <select
              value={selectedAcct}
              onChange={e => { setSelectedAcct(e.target.value); setLiveExpiries([]); setTickerInfo(null); }}
              className="flex-1 min-w-48 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            >
              <option value="">— Manual entry (no live data) —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.exchange}{a.testnet ? " (Testnet)" : ""}
                </option>
              ))}
            </select>
            {loadingChain && (
              <span className="text-xs text-slate-400 animate-pulse whitespace-nowrap">Loading chain…</span>
            )}
            {hasLiveData && !loadingChain && (
              <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2.5 py-1 text-xs font-semibold text-emerald-700 whitespace-nowrap">
                ● Live
              </span>
            )}
            <a href="/accounts" target="_blank"
              className="text-xs text-brand hover:underline whitespace-nowrap">
              Manage Accounts
            </a>
          </div>

          {/* ── Basic Info ── */}
          <Section title="Basic Info">
            <Field label="Entry Date" required>
              <input type="date" value={form.entry_date} onChange={e => set("entry_date", e.target.value)} required className={inp} />
            </Field>
            <Field label="Token" required>
              {manualToken ? (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder='e.g. "DOGE_USDC", "MATIC", "AVAX_USDC"'
                    value={form.token}
                    onChange={e => { preserveRef.current = false; set("token", e.target.value.toUpperCase()); }}
                    required
                    className={inp}
                  />
                  <button
                    type="button"
                    onClick={() => { setManualToken(false); preserveRef.current = false; set("token", ""); }}
                    className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 whitespace-nowrap"
                  >
                    ← List
                  </button>
                </div>
              ) : (
                <select
                  value={KNOWN_TOKENS.includes(form.token) ? form.token : ""}
                  onChange={e => {
                    preserveRef.current = false;
                    if (e.target.value === "__custom__") { setManualToken(true); set("token", ""); }
                    else set("token", e.target.value);
                  }}
                  required
                  className={inp}
                >
                  <option value="">— Select token —</option>
                  <option value="ETH">ETH (ETH)</option>
                  <option value="BTC">BTC (BTC)</option>
                  <option value="SOL_USDC">SOL (SOL_USDC)</option>
                  <option value="XRP_USDC">XRP (XRP_USDC)</option>
                  <option value="__custom__">Other (type manually)…</option>
                </select>
              )}
            </Field>
            <Field label="Option Type">
              <select value={form.option_type} onChange={e => set("option_type", e.target.value)} className={inp}>
                <option value="PUT">PUT</option>
                <option value="CALL">CALL</option>
              </select>
            </Field>
            <Field label="Investment">
              <input type="number" step="any" value={form.investment} onChange={e => set("investment", e.target.value)} className={inp} />
            </Field>
            <Field label="Status">
              <select value={form.status} onChange={e => set("status", e.target.value)} className={inp}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
            <Field label="End Date">
              <input type="date" value={form.end_date} onChange={e => set("end_date", e.target.value)} className={inp} />
            </Field>
          </Section>

          {/* ── Option Details ── */}
          <Section title={
            <span className="flex items-center gap-2">
              Option Details
              {hasLiveData && (
                <span className="rounded-full bg-blue-100 border border-blue-200 px-2 py-0.5 text-xs font-semibold text-blue-700">
                  LIVE FROM DERIBIT
                </span>
              )}
              {isExpired && (
                <span className="rounded-full bg-red-100 border border-red-200 px-2 py-0.5 text-xs font-semibold text-red-700">
                  ⚠ EXPIRED — pick a current expiry to trade
                </span>
              )}
            </span>
          }>
            {/* Expiry — dropdown when live, date-picker otherwise */}
            <Field label="Expiry Date">
              {hasLiveData ? (
                <select value={form.expiry} onChange={e => { preserveRef.current = false; set("expiry", e.target.value); set("options_strike", ""); }} className={inp}>
                  {/* Saved expiry isn't in the live (unexpired) list anymore — inject it
                      so the dropdown shows what's actually selected instead of silently
                      falling back to the first live option while state stays stale. */}
                  {form.expiry && !liveExpiries.some(e => e.date === form.expiry) && (
                    <option value={form.expiry}>{form.expiry} — expired, not tradeable</option>
                  )}
                  {liveExpiries.map(e => (
                    <option key={e.date} value={e.date}>{e.label} ({e.date})</option>
                  ))}
                </select>
              ) : (
                <input type="date" value={form.expiry} onChange={e => { preserveRef.current = false; set("expiry", e.target.value); }} className={inp} />
              )}
            </Field>

            {/* Strike — dropdown when live, free-text otherwise */}
            <Field label="Strike" required>
              {hasLiveData && liveStrikes.length > 0 ? (
                <select
                  value={form.options_strike}
                  onChange={e => { preserveRef.current = false; set("options_strike", e.target.value); }}
                  className={inp}
                >
                  <option value="">— Select strike —</option>
                  {liveStrikes.map(s => (
                    <option key={s} value={String(s)}>{Number(s).toLocaleString()}</option>
                  ))}
                </select>
              ) : (
                <input type="text" placeholder='e.g. "96 PUT" or "1700"' value={form.options_strike} onChange={e => { preserveRef.current = false; set("options_strike", e.target.value); }} className={inp} />
              )}
            </Field>

            {/* Refresh button + live ticker info — full width */}
            {hasLiveData && form.options_strike && form.expiry && (
              <div className="sm:col-span-2 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={refreshTicker}
                  disabled={fetchingTicker}
                  className="flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  {fetchingTicker ? "⏳" : "↺"} Refresh live price / IV
                </button>
                {tickerInfo && (
                  <span className="text-xs text-slate-400">
                    {tickerInfo.instrument} · mid&nbsp;
                    <span className="font-semibold text-emerald-600">${Number(tickerInfo.mid_price_usd ?? tickerInfo.mark_price_usd).toFixed(4)}</span>
                    &nbsp;· bid&nbsp;${Number(tickerInfo.best_bid_usd).toFixed(4)}
                    &nbsp;· ask&nbsp;${Number(tickerInfo.best_ask_usd).toFixed(4)}
                    &nbsp;· IV&nbsp;
                    <span className="font-semibold text-slate-600">{Number(tickerInfo.mark_iv).toFixed(1)}%</span>
                    &nbsp;· index&nbsp;${Number(tickerInfo.underlying_price).toFixed(2)}
                  </span>
                )}
              </div>
            )}

            <Field label="Entry Qty">
              <input type="number" step="any" value={form.opt_entry_qty} onChange={e => set("opt_entry_qty", e.target.value)} className={inp} />
            </Field>
            <Field label={tickerInfo ? "Entry Price (live mark)" : "Entry Price"}>
              <input type="number" step="any" value={form.opt_entry_price} onChange={e => set("opt_entry_price", e.target.value)} className={inp} />
            </Field>
            <Field label="Exit Price">
              <input type="number" step="any" value={form.opt_exit_price} onChange={e => set("opt_exit_price", e.target.value)} className={inp} />
            </Field>
            <Field label={tickerInfo ? "Implied Vol Σ (%) (live)" : "Implied Volatility (%)"}>
              <input type="number" step="0.5" min="1" max="500" placeholder="e.g. 30" value={form.iv} onChange={e => set("iv", e.target.value)} className={inp} />
            </Field>
          </Section>

          {/* ── Futures Details ── */}
          <Section title="Futures Details">
            {futuresHasBothTypes(form.token) && (
              <Field label="Futures Instrument">
                <select
                  value={form.fut_instrument_type || "inverse"}
                  onChange={e => { preserveRef.current = false; set("fut_instrument_type", e.target.value); }}
                  className={inp}
                >
                  <option value="inverse">Inverse — {(form.token || "BTC").toUpperCase()}-PERPETUAL</option>
                  <option value="linear">Linear/USDC — {(form.token || "BTC").toUpperCase()}_USDC-PERPETUAL</option>
                </select>
              </Field>
            )}
            <Field label="Fut Qty">
              <input type="number" step="any" value={form.fut_qty} onChange={e => set("fut_qty", e.target.value)} className={inp} />
            </Field>
            <Field label={hasLiveData && form.fut_entry_price ? "Fut Entry Price (live)" : "Fut Entry Price"}>
              <input type="number" step="any" value={form.fut_entry_price} onChange={e => set("fut_entry_price", e.target.value)} className={inp} />
            </Field>
            <Field label="Fut Exit Price">
              <input type="number" step="any" value={form.fut_exit_price} onChange={e => set("fut_exit_price", e.target.value)} className={inp} />
            </Field>
          </Section>

          {/* ── Distances & Basket ── */}
          <Section title="Distances & Basket">
            <Field label="Upside Distance"><input type="number" step="any" value={form.upside_distance} onChange={e => set("upside_distance", e.target.value)} className={inp} /></Field>
            <Field label="Down Distance"><input type="number" step="any" value={form.down_distance} onChange={e => set("down_distance", e.target.value)} className={inp} /></Field>
            <Field label="Basket Distance"><input type="number" step="any" value={form.basket_distance} onChange={e => set("basket_distance", e.target.value)} className={inp} /></Field>
            <Field label="Basket Loss"><input type="number" step="any" value={form.basket_loss} onChange={e => set("basket_loss", e.target.value)} className={inp} /></Field>
          </Section>

          {/* ── Close / Booked ── */}
          <Section title="Close / Booked">
            <Field label="Net Booked PnL"><input type="number" step="any" value={form.net_booked_pnl} onChange={e => set("net_booked_pnl", e.target.value)} className={inp} /></Field>
            <Field label="Market Making PL"><input type="number" step="any" value={form.market_making_pl} onChange={e => set("market_making_pl", e.target.value)} className={inp} /></Field>
          </Section>

          {/* ── Action buttons ── */}
          <div className="flex flex-wrap items-end gap-3">
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
            <button type="button" onClick={() => { setForm(EMPTY); setTickerInfo(null); }}
              className="rounded-lg border border-slate-200 px-6 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Reset
            </button>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Target PnL ($)</label>
              <input
                type="number" step="any" min="0" placeholder="e.g. 5"
                value={acTargetPnl}
                onChange={e => setAcTargetPnl(e.target.value)}
                className="w-28 rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:border-brand focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={handleExecuteAndAutoClose}
              disabled={executing || acStarting || !selectedAcct || entryPhase === "option_pending" || entryPhase === "futures_pending" || (isExpired && !!parseFloat(form.opt_entry_qty))}
              title={isExpired && parseFloat(form.opt_entry_qty) ? "This expiry has already passed — pick a current one first" : undefined}
              className="rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
            >
              {executing ? "Executing…" : acStarting ? "Starting Monitor…" : "⚡ Execute + Auto-Close"}
            </button>
          </div>
          {acError && <Alert type="error">{acError}</Alert>}

          {/* Entry status banner */}
          {entryPhase === "option_pending" && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
                <span className="text-sm font-semibold text-orange-700">Option order open — tracking mid price every 5 s, will re-place if it moves</span>
              </div>
              <button type="button" onClick={cancelEntryOrder}
                className="shrink-0 rounded border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50">
                ✕ Cancel
              </button>
            </div>
          )}
          {entryPhase === "futures_pending" && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-semibold text-blue-700">Option filled — placing futures market order…</span>
            </div>
          )}
          {entryPhase === "done" && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
              ✓ All orders completed successfully
            </div>
          )}

          {executeError && <Alert type="error">Execute Error: {executeError}</Alert>}

          {/* Entry activity log */}
          {entryLogs.length > 0 && (
            <div className="rounded-lg bg-slate-900 p-3 max-h-36 overflow-y-auto space-y-0.5">
              {entryLogs.map((l, i) => (
                <div key={i} className={`text-xs font-mono ${
                  l.includes("failed") || l.includes("error") || l.includes("Error") ? "text-red-400"
                  : l.includes("filled") || l.includes("completed") || l.includes("Done") ? "text-green-400"
                  : l.includes("re-placing") || l.includes("→") ? "text-yellow-300"
                  : "text-slate-300"}`}>{l}</div>
              ))}
            </div>
          )}

          {/* ── Auto-Close on Profit (server-side job) ── */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-slate-800">Auto-Close on Profit</h3>
              {acJob && (
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold border ${
                  acJob.status === "completed" ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                  : acJob.status === "failed"  ? "bg-red-100 text-red-700 border-red-200"
                  : acJob.status === "stopped" ? "bg-slate-100 text-slate-500 border-slate-200"
                  : "bg-orange-100 text-orange-700 border-orange-200 animate-pulse"
                }`}>
                  {acJob.status === "active"          ? "● MONITORING"
                   : acJob.status === "closing_option"  ? "● CLOSING OPTION"
                   : acJob.status === "closing_futures" ? "● CLOSING FUTURES"
                   : acJob.status === "completed"       ? "✓ DONE"
                   : acJob.status === "failed"           ? "✕ FAILED"
                   : acJob.status === "stopped"          ? "■ STOPPED"
                   : acJob.status.toUpperCase()}
                </span>
              )}
            </div>

            {acError && <Alert type="error">{acError}</Alert>}

            {(!acJob || ["completed","failed","stopped"].includes(acJob.status)) && (
              <>
                {acJob && (
                  <div className={`rounded-lg border px-3 py-2 text-xs ${
                    acJob.status === "completed" ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                    : acJob.status === "failed"  ? "bg-red-50 border-red-200 text-red-700"
                    : "bg-slate-50 border-slate-200 text-slate-600"
                  }`}>
                    Previous job #{acJob.id}: {acJob.status}{acJob.error_msg ? ` — ${acJob.error_msg}` : ""}
                  </div>
                )}
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">Booking PnL Target ($)</label>
                    <input
                      type="number" step="any" min="0" placeholder="e.g. 500"
                      value={acTargetPnl}
                      onChange={e => setAcTargetPnl(e.target.value)}
                      className="w-36 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-500">Monitors</label>
                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      Account Equity ($) — frozen at start, runs on server
                    </div>
                  </div>
                  {parseFloat(acTargetPnl) > 0 && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">Closes When PnL ≥</label>
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                        +${parseFloat(acTargetPnl).toFixed(2)}
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={startAutoClose}
                    disabled={acStarting || !selectedAcct || !currentInst || !parseFloat(acTargetPnl)}
                    className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    {acStarting ? "Starting…" : "▶ Start Auto-Close"}
                  </button>
                </div>
                <p className="text-xs text-slate-400">
                  Runs on the server — keeps monitoring and closes automatically even if you close this tab.
                </p>
              </>
            )}

            {acJob && ["active","closing_option","closing_futures"].includes(acJob.status) && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <p className="text-slate-400 mb-0.5">Initial (Frozen)</p>
                    <p className="font-bold text-slate-700">${parseFloat(acJob.initial_total_usd).toFixed(2)}</p>
                  </div>
                  <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                    <p className="text-slate-400 mb-0.5">Current (Live)</p>
                    <p className="font-bold text-blue-700">{acJob.last_equity_usd != null ? `$${parseFloat(acJob.last_equity_usd).toFixed(2)}` : "—"}</p>
                  </div>
                  {(() => {
                    const pnl = acJob.last_equity_usd != null ? parseFloat(acJob.last_equity_usd) - parseFloat(acJob.initial_total_usd) : null;
                    return (
                      <div className={`rounded-lg border p-3 ${pnl != null ? (pnl >= 0 ? "bg-emerald-50 border-emerald-100" : "bg-red-50 border-red-100") : "bg-slate-50 border-slate-100"}`}>
                        <p className="text-slate-400 mb-0.5">Live PnL</p>
                        <p className={`font-bold ${pnl != null ? (pnl >= 0 ? "text-emerald-600" : "text-red-600") : "text-slate-500"}`}>
                          {pnl != null ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "—"}
                        </p>
                      </div>
                    );
                  })()}
                </div>

                {acJob.last_equity_usd != null && (() => {
                  const pnl = parseFloat(acJob.last_equity_usd) - parseFloat(acJob.initial_total_usd);
                  const tgt = parseFloat(acJob.target_pnl);
                  const pct = tgt > 0 ? Math.min(100, Math.max(0, (pnl / tgt) * 100)) : 0;
                  return (
                    <div>
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>$0</span>
                        <span className="flex items-center gap-1.5">
                          Target +${tgt.toFixed(2)}
                          {acJob.status === "active" && !editingTarget && (
                            <button
                              type="button"
                              onClick={() => { setEditingTarget(true); setEditTargetValue(String(tgt)); setAcError(null); }}
                              className="text-brand underline hover:no-underline"
                            >
                              Edit
                            </button>
                          )}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}

                {editingTarget && (
                  <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                    <label className="text-xs font-medium text-slate-600 whitespace-nowrap">New target ($)</label>
                    <input
                      type="number" step="any" min="0"
                      value={editTargetValue}
                      onChange={e => setEditTargetValue(e.target.value)}
                      className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={editAutoCloseTarget}
                      disabled={acStarting}
                      className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      {acStarting ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTarget(false)}
                      className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <p className="text-xs text-slate-500">
                  {acJob.opt_instrument}{acJob.opt_filled_qty != null ? ` — filled ${acJob.opt_filled_qty}/${acJob.opt_qty}` : ` — ${acJob.opt_qty}x`}
                  {acJob.fut_instrument ? ` · ${acJob.fut_instrument}` : ""}
                </p>

                {acJob.error_msg && <p className="text-xs text-red-600 font-mono">{acJob.error_msg}</p>}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={stopAutoClose}
                    className="rounded-lg border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                  >
                    ■ Stop Auto-Close
                  </button>
                  {isEdit && (
                    <Link
                      href={`/options/monitor/${tradeId}`}
                      className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      View Full Monitor →
                    </Link>
                  )}
                </div>
              </div>
            )}

            {acJob?.logs?.length > 0 && (
              <div className="rounded-lg bg-slate-900 p-3 max-h-52 overflow-y-auto font-mono text-xs text-slate-300 space-y-0.5">
                {[...acJob.logs].reverse().map((l, i) => (
                  <div key={i} className={
                    l.includes("failed") || l.includes("Error") || l.includes("Fatal") ? "text-red-400"
                    : l.includes("TARGET") || l.includes("filled") || l.includes("complete") ? "text-emerald-400"
                    : ""
                  }>{l}</div>
                ))}
              </div>
            )}
          </div>
        </form>

        {/* RIGHT: live auto-calc panel */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card sticky top-6">
            <h2 className="mb-4 text-sm font-semibold text-slate-700">Auto-Calculated (Live)</h2>

            <CalcGroup title="General / Theta">
              <CalcRow label="Days to Expiry"  value={fmt(derived.days_to_expiry, "number")} />
              <CalcRow label="Total Theta"      value={fmt(derived.total_theta_gain_loss)} />
              <CalcRow label="Per Day Theta"    value={fmt(derived.per_day_theta_gain_loss)} signed />
              <CalcRow label="Total Baskets"    value={fmt(derived.total_baskets, "number")} />
              <CalcRow label="Total MM Loss"    value={fmt(derived.total_mm_loss)} loss />
            </CalcGroup>

            <CalcGroup title="Limits">
              <CalcRow label="Upper Limit" value={fmt(derived.upper_limit, "number")} />
              <CalcRow label="Lower Limit" value={fmt(derived.lower_limit, "number")} />
            </CalcGroup>

            <CalcGroup title="📈 Upside">
              <CalcRow label="Opt PnL (Upside)" value={fmt(derived.upside_opt_pnl)} signed />
              <CalcRow label="Fut PnL (Upside)" value={fmt(derived.upside_fut_pnl)} signed />
            </CalcGroup>

            <CalcGroup title="📉 Downside">
              <CalcRow label="Opt PnL (Down)"   value={fmt(derived.down_opt_pnl)} signed />
              <CalcRow label="Fut PnL (Down)"   value={fmt(derived.downside_fut_pnl)} signed />
            </CalcGroup>

            <CalcGroup title="Return">
              <CalcRow label="APY" value={derived.apy != null ? `${Number(derived.apy).toFixed(2)}%` : "—"} signed big />
            </CalcGroup>

            <CalcGroup title={`📊 BS Option PNL (IV ${form.iv || 30}%, ${dte_bs}d)`}>
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
              <CalcRow label="At Current Price (Today BS)" value={fmt(bsTodayPnl)}      signed big />
              <CalcRow label="Breakeven Price" value={bsBreakeven != null ? bsBreakeven.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} />
            </CalcGroup>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────── */

const inp = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand focus:outline-none";

function Section({ title, children }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-card">
      <h2 className="mb-4 text-sm font-semibold text-slate-700 flex items-center gap-2">{title}</h2>
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
  const isNum  = !isNaN(rawNum);
  const color  = loss ? "text-red-600"
    : signed && isNum && rawNum < 0  ? "text-red-700"
    : signed && isNum && rawNum >= 0 ? "text-emerald-700"
    : "text-slate-700";
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

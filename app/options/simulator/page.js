"use client";

import { useState, useEffect, useRef, useMemo, Suspense, forwardRef, useImperativeHandle } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { computeDerived, strikeNumber } from "../../../lib/options-calculations";
import { expiryPnl, currentPnl } from "../../../lib/black-scholes";

const RISK_FREE = 0.05;

const EMPTY = {
  entry_date: "", token: "", investment: "",
  options_strike: "", expiry: "",
  opt_entry_qty: "", opt_entry_price: "", opt_exit_price: "", iv: "",
  opt_mid_price_raw: "",  // raw (BTC/ETH) mid price for maker limit orders
  fut_qty: "", fut_entry_price: "", fut_exit_price: "", fut_instrument_type: "inverse",
  fut_mid_price: "",      // USD mid price for futures maker limit orders
  upside_distance: "", down_distance: "", basket_distance: "", basket_loss: "",
  fut_pnl: "", opt_pnl: "",
  net_booked_pnl: "", market_making_pl: "", end_date: "", status: "open",
};

const LEG_OPTIONS = ["CALL LONG", "CALL SHORT", "PUT LONG", "PUT SHORT"];

// BTC/ETH have both an inverse perpetual (BTC-PERPETUAL) and a USDC-margined
// linear perpetual (BTC_USDC-PERPETUAL). Tokens that are already USDC-linear
// (SOL_USDC, XRP_USDC, ...) only have one form — futType is ignored for those.
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

// Friendly label → Deribit currency code (SOL uses SOL_USDC on Deribit)
const KNOWN_TOKENS = [
  { label: "ETH",  value: "ETH"      },
  { label: "BTC",  value: "BTC"      },
  { label: "SOL",  value: "SOL_USDC" },
  { label: "XRP",  value: "XRP_USDC" },
];

const LEG_STYLES = {
  "CALL LONG":  { badge: "bg-emerald-100 text-emerald-700 border-emerald-200", dot: "bg-emerald-500", txt: "text-emerald-700" },
  "CALL SHORT": { badge: "bg-orange-100  text-orange-700  border-orange-200",  dot: "bg-orange-500",  txt: "text-orange-700"  },
  "PUT LONG":   { badge: "bg-blue-100    text-blue-700    border-blue-200",    dot: "bg-blue-500",    txt: "text-blue-700"    },
  "PUT SHORT":  { badge: "bg-red-100     text-red-700     border-red-200",     dot: "bg-red-500",     txt: "text-red-700"     },
};

const n = (v) => Number(v) || 0;

// Show an option premium at the precision the instrument actually trades at.
// Deribit prices sit on a per-instrument tick grid — SOL_USDC options tick at
// 0.1, so a mark of 1.5488 is displayed as 1.5, not 1.5488, because no order
// can exist at the latter. Only applies to linear (USDC/USDT) instruments,
// where the quote currency is USD; on coin-margined options the tick governs
// the coin-denominated premium and says nothing about the converted USD
// figure, so those keep the generic 4dp.
function fmtOptPrice(value, ticker) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (ticker?.is_linear && ticker?.tick_size > 0) {
    return n.toFixed(Math.max(0, -Math.floor(Math.log10(ticker.tick_size))));
  }
  return n.toFixed(4);
}

// Build Deribit instrument name from parts
function buildDeribitInst(token, expiry, strike, optType) {
  if (!token || !expiry || !strike) return null;
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const d = new Date(expiry + "T00:00:00Z");
  if (isNaN(d)) return null;
  // Deribit does NOT zero-pad single-digit days (BTC-1AUG26-..., not
  // BTC-01AUG26-...) — padding here builds a name Deribit doesn't recognize.
  const day = String(d.getUTCDate());
  const mon = MONTHS[d.getUTCMonth()];
  const yr  = String(d.getUTCFullYear()).slice(-2);
  return `${token.toUpperCase()}-${day}${mon}${yr}-${strike}-${optType === "CALL" ? "C" : "P"}`;
}

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
    iv:               t.iv                         ?? "",
    fut_qty:              t.fut_qty                   ?? "",
    fut_entry_price:      t.fut_entry_price           ?? "",
    fut_exit_price:       t.fut_exit_price            ?? "",
    fut_instrument_type:  t.fut_instrument_type       || "inverse",
    upside_distance:  t.upside_distance           ?? "",
    down_distance:    t.down_distance             ?? "",
    basket_distance:  t.basket_distance           ?? "",
    basket_loss:      t.basket_loss               ?? "",
    fut_pnl:          t.fut_pnl                    ?? "",
    opt_pnl:          t.opt_pnl                    ?? "",
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

  const [legs,          setLegs]          = useState([makeLeg("CALL LONG"), makeLeg("PUT LONG")]);
  const [editIds,       setEditIds]       = useState([]);
  const [loadErr,       setLoadErr]       = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState(null);
  const [saveErr,       setSaveErr]       = useState(null);
  const [accounts,      setAccounts]      = useState([]);
  const [selectedAcct,  setSelectedAcct]  = useState("");
  const [executing,     setExecuting]     = useState(false);
  const [executeResult, setExecuteResult] = useState(null);
  const [executeError,  setExecuteError]  = useState(null);

  // Smart per-leg entry engine (maker-chase options, market futures — same
  // policy as the single-strategy page — all legs placed in parallel).
  const [comboEntryPhase, setComboEntryPhase] = useState("idle"); // idle|running|done|error
  const [comboEntryLogs,  setComboEntryLogs]  = useState([]);
  const comboCancelRef      = useRef(false);
  const comboFilledLegsRef  = useRef([]);
  const comboGroupIdRef     = useRef(null);

  // Combo auto-close (server-side job spanning all legs, combined equity trigger)
  const [comboTargetPnl,        setComboTargetPnl]        = useState("");
  // 'coin' — track only the group's own coin equity (BTC/ETH), ignoring the
  // USDC/futures-hedge side entirely. 'combined' — whole account (coin +
  // USDC summed), the original behavior. Only meaningful for coin-margined
  // tokens. See app/options/add/page.js for the incident behind the default.
  const [comboMonitorMode,      setComboMonitorMode]      = useState("coin");
  const [comboAcJob,            setComboAcJob]            = useState(null); // { job, legs }
  const [comboAcStarting,       setComboAcStarting]       = useState(false);
  const [comboAcError,          setComboAcError]          = useState(null);
  const [comboAutoCloseAfterEntry, setComboAutoCloseAfterEntry] = useState(false);
  const comboAcTimerRef = useRef(null);

  // Refs to each LegCard's imperative refreshTicker(), so one button can
  // refresh every leg's live entry price, IV, and futures price at once.
  const legRefs = useRef([]);
  const [refreshingAll, setRefreshingAll] = useState(false);
  async function refreshAllLegs() {
    setRefreshingAll(true);
    try {
      await Promise.all(legRefs.current.map(r => r?.refreshTicker?.()));
    } finally {
      setRefreshingAll(false);
    }
  }

  const deriveds = useMemo(() => legs.map((l) => computeDerived(l.form)), [legs]);

  // Visual grouping only — CALL legs together, then PUT legs together.
  // Sorts INDICES, not the legs array itself, so leg_index (execution
  // order, DB storage, worker log/alert "Leg N" labels) never changes —
  // only where each card appears on screen. Stable sort (guaranteed in
  // Node/V8) preserves relative order within each group.
  const legDisplayOrder = useMemo(
    () => legs.map((_, i) => i).sort((a, b) => {
      const groupOf = (t) => (t || "").startsWith("CALL") ? 0 : 1;
      return groupOf(legs[a].type) - groupOf(legs[b].type);
    }),
    [legs]
  );

  useEffect(() => {
    fetch("/api/accounts")
      .then(r => r.json())
      .then(d => {
        const list = d.accounts || [];
        setAccounts(list);
        // Restore last-used account from localStorage — but only for a NEW
        // strategy. In edit mode this must NOT run: it's a global "last used
        // across any strategy" value, so it would clobber the account this
        // specific group was actually saved with (the group-loading effect
        // below sets the real one). Whichever of these two effects resolves
        // last previously decided the account, causing every edit page to
        // show whatever account was most recently used anywhere.
        if (editGroup) return;
        const saved = typeof window !== "undefined" && localStorage.getItem("options_last_account");
        if (saved && list.some(a => String(a.id) === saved)) setSelectedAcct(saved);
        else if (list.length === 1) setSelectedAcct(String(list[0].id));
      })
      .catch(() => {});
  }, [editGroup]);

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
        // Restore the account this group was actually saved with.
        const savedAcctId = members[0]?.account_id;
        if (savedAcctId) setSelectedAcct(String(savedAcctId));
      })
      .catch((e) => setLoadErr(e.message));
  }, [editGroup]);

  // Resume polling if a combo auto-close job is already active for this group
  useEffect(() => {
    if (!editGroup) return;
    comboGroupIdRef.current = editGroup;
    fetch(`/api/auto-close-combo?group_id=${encodeURIComponent(editGroup)}`).then(r => r.json()).then(d => {
      const activeJob = (d.jobs || []).find(j => ["active", "closing"].includes(j.status));
      if (activeJob) {
        clearInterval(comboAcTimerRef.current);
        pollComboAcJob(activeJob.id);
        comboAcTimerRef.current = setInterval(() => pollComboAcJob(activeJob.id), 5000);
      }
    }).catch(() => {});
  }, [editGroup]);

  // Combined "Execute + Auto-Close" flow — the instant every leg's entry
  // finishes, immediately start the combo auto-close job (same rationale as
  // the single-strategy page: no gap for price/PnL to drift before the
  // initial collateral snapshot is taken).
  useEffect(() => {
    if (comboEntryPhase === "done" && comboAutoCloseAfterEntry) {
      setComboAutoCloseAfterEntry(false);
      startComboAutoClose(comboFilledLegsRef.current);
    }
    if (comboEntryPhase === "error" && comboAutoCloseAfterEntry) {
      setComboAutoCloseAfterEntry(false);
    }
  }, [comboEntryPhase, comboAutoCloseAfterEntry]);

  // Cleanup on unmount
  useEffect(() => { return () => clearInterval(comboAcTimerRef.current); }, []);

  /* ── Leg helpers ──────────────────────────────────── */
  // A new leg starts out following the first card's distances, same as any
  // other non-overridden leg — otherwise it would be the one card sitting at
  // blank while the rest share a value.
  function addLeg() {
    setLegs((prev) => {
      const leg    = makeLeg("CALL LONG");
      const master = prev[masterLegIdx];
      if (master) for (const k of SYNCED_KEYS) leg.form[k] = syncedValueFor(k, master.form[k] ?? "", leg.type);
      return [...prev, leg];
    });
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

  // Distances are almost always the same across every leg of one structure,
  // so the first card acts as the source and the rest follow it. A leg that
  // gets its own value edited directly is flagged as overridden and stops
  // following, so a deliberate per-leg number is never silently overwritten
  // by a later edit to the first card.
  //
  // "First card" is legDisplayOrder[0] — the card actually at the top of the
  // screen — not legs[0]. Cards are displayed CALLs-first, so those differ
  // whenever leg 1 is a PUT, and following the array order would make edits
  // propagate from a card in the middle of the page.
  // entry_date and expiry are properties of the STRUCTURE, not of any one
  // leg — every leg of a combined strategy is opened the same day against the
  // same expiry — so they follow the first card too. Both copy verbatim; only
  // opt_entry_qty needs a per-leg transform (see syncedValueFor).
  // Every leg of one structure normally shares the same coin, entry date and
  // expiry — only strike and direction differ — so the first card drives those
  // too. After a token lands on the other legs, each card's own chain effect
  // reloads its expiry list; since they all now hold the same token they
  // settle on the same chain.
  // status and end_date sync too: legs of one structure are opened and closed
  // together, so marking the first card closed on a given date should carry
  // across rather than leaving the rest showing open.
  const SYNCED_KEYS  = ["upside_distance", "down_distance", "opt_entry_qty", "entry_date", "expiry", "token", "status", "end_date", "fut_entry_price"];
  // Changing either of these invalidates a strike picked under the old chain —
  // a strike listed for one expiry often doesn't exist in another, and would
  // otherwise build an instrument name Deribit rejects. The first card already
  // clears its own strike on these edits; followers must do the same.
  const STRIKE_INVALIDATING = ["expiry", "token"];
  const masterLegIdx = legDisplayOrder[0];

  // Quantity propagates by MAGNITUDE, with each leg supplying its own sign:
  // this app encodes direction in the sign of opt_entry_qty (short = negative,
  // as applyLegType already enforces on a type change). Copying the raw value
  // across would turn every leg into the same direction as the first card and
  // silently invert half the structure. So 1000 on a long card becomes -1000
  // on the short legs. Distances carry no direction and copy verbatim.
  function syncedValueFor(key, value, legType) {
    if (key !== "opt_entry_qty") return value;
    if (value === "" || value == null) return value;
    const n = Math.abs(Number(value));
    if (!Number.isFinite(n)) return value;
    return String((legType || "").endsWith("SHORT") ? -n : n);
  }

  function setLegField(idx, key, value) {
    const synced = SYNCED_KEYS.includes(key);
    setLegs((prev) => prev.map((l, i) => {
      if (i === idx) {
        const next = { ...l, form: { ...l.form, [key]: value } };
        if (synced && idx !== masterLegIdx) {
          next.overrides = { ...(l.overrides || {}), [key]: true };
        }
        return next;
      }
      if (synced && idx === masterLegIdx && !(l.overrides || {})[key]) {
        const patch = { [key]: syncedValueFor(key, value, l.type) };
        if (STRIKE_INVALIDATING.includes(key)) patch.options_strike = "";
        return { ...l, form: { ...l.form, ...patch } };
      }
      return l;
    }));
  }

  // Re-link a leg to the first card's value after it was overridden.
  function relinkLegField(idx, key) {
    setLegs((prev) => {
      const masterValue = prev[masterLegIdx]?.form?.[key] ?? "";
      return prev.map((l, i) => {
        if (i !== idx) return l;
        const overrides = { ...(l.overrides || {}) };
        delete overrides[key];
        return { ...l, overrides, form: { ...l.form, [key]: syncedValueFor(key, masterValue, l.type) } };
      });
    });
  }

  function setLegBulk(idx, updates) {
    setLegs((prev) => prev.map((l, i) =>
      i === idx ? { ...l, form: { ...l.form, ...updates } } : l
    ));
  }

  /* ── Combined figures ───────────────────────────────── */
  const totalInvestment      = legs.reduce((s, l) => s + n(l.form.investment), 0);
  const bookedPnl            = legs.reduce((s, l) => s + n(l.form.net_booked_pnl), 0);
  const mmPl                 = legs.reduce((s, l) => s + n(l.form.market_making_pl), 0);
  const combinedApy          = totalInvestment ? (bookedPnl / totalInvestment) * 365 * 100 : null;
  const combinedTotalTheta   = deriveds.reduce((s, d) => s + (d.total_theta_gain_loss  ?? 0), 0);
  const combinedPerDayTheta  = deriveds.reduce((s, d) => s + (d.per_day_theta_gain_loss ?? 0), 0);

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

  function legBsTodayPnl(form, optType, S_target) {
    const K    = strikeNumber(form.options_strike);
    const ep   = parseFloat(form.opt_entry_price) || 0;
    const qty  = parseFloat(form.opt_entry_qty)   || 0;
    if (!K || !qty) return 0;
    const sigma = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const expD  = form.expiry ? (() => { const d = new Date(form.expiry); d.setHours(0,0,0,0); return d; })() : null;
    const dte   = expD ? Math.max(0, Math.round((expD - today) / 86400000)) : 0;
    const T     = dte / 365;
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

  /* ── Smart per-leg entry engine ───────────────────────
     Option: maker limit at mid, chases the mid every 5s until filled —
     never falls back to market. Futures: market, right after the option
     fills. Same policy as the single-strategy page, applied per leg,
     sequentially (leg 2 doesn't start until leg 1 is fully done). */
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function addComboLog(msg) {
    const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
    setComboEntryLogs(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 100));
  }

  // `h` is this leg's hedge state (see syncLegHedge). It is mutated in place
  // so the caller still holds the true filled/hedged totals even when this
  // throws — a stop mid-fill must not lose track of what already executed,
  // or the filled portion would be left unhedged.
  async function runLegOptionEntry({ accountId, currency, optInst, optQty, h, legLabel, blocking = [], progress, progressIdx }) {
    const optDir = optQty > 0 ? "buy" : "sell";
    const totalQty = Math.abs(optQty);
    // Cumulative fill across all re-quotes for this leg — a re-quote after
    // a partial fill must place only the REMAINING unfilled qty, not the
    // full original size again. Confirmed incident: a 3-lot order
    // partially filled 2 lots, got cancelled to re-quote, and the
    // replacement was placed for the full 3 lots again instead of the 1
    // lot still outstanding.
    let filledSoFar = 0;
    // Weighted-average entry price across every order this leg takes to
    // fill — a re-quote after a partial fill means the leg can fill across
    // several orders at different prices, and using only the last order's
    // price (or a post-fill ticker snapshot) doesn't reflect what was
    // actually paid/received.
    let fillWeightedSum = 0;

    async function place(mid) {
      // Re-checked right before every order placement, not just once at the
      // top of a loop iteration — the user can click Cancel at any point,
      // including while an iteration is already mid-flight past its own
      // earlier checks. This is the guard that actually stops a runaway
      // loop; setting the ref alone doesn't abort work already in progress.
      if (comboCancelRef.current) throw new Error("Cancelled by user");
      const remainingQty = Math.max(0, totalQty - filledSoFar);
      addComboLog(`Placing ${optDir} ${remainingQty}x ${optInst} @ mid ${mid.toFixed(5)}`);
      const res = await fetch("/api/deribit-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, instrument: optInst, qty: remainingQty, direction: optDir, price: mid, is_market: false, post_only: false }),
      });
      const data = await res.json();
      if (!res.ok || !data.order_id) throw new Error(`Option order failed: ${data.error}`);
      addComboLog(`Order #${data.order_id.slice(-8)} — ${data.order_state}`);
      if (data.order_state === "filled") {
        fillWeightedSum += remainingQty * (parseFloat(data.price) || mid);
        filledSoFar = totalQty;
        if (h) h.filledOpt = totalQty;
        if (progress && progressIdx != null) progress[progressIdx].filled = totalQty;
      }
      return { orderId: data.order_id, mid, filled: data.order_state === "filled" };
    }

    const tickRes  = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=ticker&instrument=${encodeURIComponent(optInst)}`);
    const tickData = await tickRes.json();
    const initialMid = tickData.mid_price_raw ?? 0;
    if (!initialMid) throw new Error(`Could not get option mid price for ${optInst}`);

    let { orderId, mid, filled } = await place(initialMid);
    if (filled) addComboLog("Option filled immediately!");

    // A leg with partners queued behind it stalls the whole spread when it
    // won't fill, and by design nothing overrides that — so say so, loudly and
    // once, rather than letting it sit silently.
    let waitTicks = 0, stallWarned = false;
    while (!filled) {
      if (comboCancelRef.current) {
        await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${orderId}`, { method: "DELETE" }).catch(() => {});
        throw new Error("Cancelled by user");
      }
      if (blocking.length && !stallWarned && ++waitTicks >= 30) {  // ~60s at 2s/tick
        stallWarned = true;
        addComboLog(`⚠ ${legLabel} has not filled after ~60s — ${blocking.join(", ")} still held. Nothing else in this spread will be placed until it fills; STOP and adjust if needed.`);
      }
      await sleep(2000);
      if (comboCancelRef.current) {
        await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${orderId}`, { method: "DELETE" }).catch(() => {});
        throw new Error("Cancelled by user");
      }
      const stRes  = await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${orderId}`);
      const stData = await stRes.json();
      const filledOnThisOrder = parseFloat(stData.filled_amount ?? 0);
      const cumFilled = filledSoFar + filledOnThisOrder;
      // Publish the live fill so the hedge tracks it continuously — and so a
      // stop at this instant still knows exactly how much needs hedging.
      if (progress && progressIdx != null) progress[progressIdx].filled = cumFilled;
      if (h) {
        h.filledOpt = cumFilled;
        try {
          await syncLegHedge({ accountId, currency, h, progress, settled: false, legLabel });
        } catch (e) { addComboLog(`${legLabel} hedge error: ${e.message}`); }
      }
      if (stData.order_state === "filled" || cumFilled >= totalQty - 1e-9) {
        addComboLog("Option filled!");
        fillWeightedSum += filledOnThisOrder * (parseFloat(stData.price) || mid);
        filledSoFar = totalQty;
        if (h) h.filledOpt = totalQty;
        if (progress && progressIdx != null) progress[progressIdx].filled = totalQty;
        filled = true;
        break;
      }

      const tRes  = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=ticker&instrument=${encodeURIComponent(optInst)}`);
      const tData = await tRes.json();
      const newMid = tData.mid_price_raw ?? 0;
      if (newMid > 0 && Math.abs(newMid - mid) > 0.00002) {
        addComboLog(`Mid ${mid.toFixed(5)} → ${newMid.toFixed(5)}, re-placing for remaining ${(totalQty - cumFilled).toFixed(4)}`);
        // Confirm the cancel actually went through before placing a
        // replacement — otherwise a failed/late cancel (e.g. the order
        // just filled) leaves the old order live and a new one gets placed
        // on top of it. Confirmed incident: two full-size orders open
        // simultaneously, 5 seconds apart. The cancel response also carries
        // the most accurate filled_amount at the moment of cancellation.
        const cancelRes  = await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${orderId}`, { method: "DELETE" });
        const cancelData = await cancelRes.json().catch(() => ({}));
        if (!cancelRes.ok) {
          addComboLog(`Cancel failed (${cancelData.error || cancelRes.status}) — re-checking next tick instead of placing a duplicate order.`);
          continue;
        }
        const filledByThisOrder = parseFloat(cancelData.filled_amount ?? filledOnThisOrder);
        fillWeightedSum += filledByThisOrder * (parseFloat(cancelData.price) || mid);
        filledSoFar = filledSoFar + filledByThisOrder;
        if (h) h.filledOpt = filledSoFar;
        if (progress && progressIdx != null) progress[progressIdx].filled = filledSoFar;
        if (filledSoFar >= totalQty - 1e-9) {
          addComboLog("Option filled during cancel!");
          filledSoFar = totalQty;
          filled = true;
          break;
        }
        ({ orderId, mid, filled } = await place(newMid));
      } else if (filledOnThisOrder > 0) {
        addComboLog(`Partially filled ${filledOnThisOrder} on this order — waiting @ ${mid.toFixed(5)}`);
      } else {
        addComboLog(`Waiting — order open @ ${mid.toFixed(5)}`);
      }
    }

    // fillWeightedSum/totalQty is the TRUE average fill price across every
    // order this leg took to fill, in Deribit's raw coin-denominated terms
    // (e.g. 0.0195 ETH) — options are quoted that way, not in USD. Convert
    // using a fresh underlying price fetch (the option's own raw price can
    // legitimately move a lot between re-quotes; the underlying moving
    // slightly in the few seconds since the last tick is a much smaller
    // residual error than using the wrong price entirely, which is what a
    // post-fill ticker snapshot did before this fix).
    const avgPriceRaw = totalQty > 0 ? fillWeightedSum / totalQty : null;
    // Linear (USDC/USDT-settled) tokens like SOL_USDC/XRP_USDC quote the
    // option premium directly in USD already — multiplying by underlying_price
    // (~$74 for SOL) would inflate a ~$1 premium to ~$74. Mirrors the isLinear
    // check in /api/market's ticker route.
    if (/_USDC$|_USDT$/i.test(currency)) return avgPriceRaw;
    try {
      const tRes  = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=ticker&instrument=${encodeURIComponent(optInst)}`);
      const tData = await tRes.json();
      if (avgPriceRaw != null) {
        const toUsd = tData.underlying_price || (tData.mark_price_raw ? tData.mark_price_usd / tData.mark_price_raw : 1);
        return avgPriceRaw * toUsd;
      }
      return tData.mark_price_usd ?? null;
    } catch { return null; }
  }

  // Brings ONE leg's futures hedge up to the fraction of that leg's option
  // which has actually filled. Same two changes as the single-leg page:
  //
  //  1. PROPORTIONAL, not all-or-nothing. Previously a leg whose option was
  //     stopped or errored mid-fill was marked "rejected" and its futures step
  //     skipped entirely — leaving the filled portion of a short option naked,
  //     which on a short call is unbounded risk.
  //  2. MAKER, not market. Posted at the near touch with post_only: Deribit
  //     charges 0% maker vs 0.05% taker on BTC-PERPETUAL, and post_only makes
  //     Deribit reprice rather than let the order cross, so it can never
  //     silently pay taker.
  //
  // Progress is tracked as a FRACTION of each order (filled_amount ÷ amount),
  // which is unit-free — "amount" is USD notional for inverse futures but coin
  // qty for linear ones, and the client never has to replicate that mapping.
  // `h` is the leg's mutable hedge state; returns true once caught up.
  // `progress` is the shared per-leg fill tally for the whole structure:
  // [{ filled, total }, ...]. The hedge tracks the STRUCTURE's fill, not the
  // fill of whichever leg happens to carry fut_qty — measuring per-leg made
  // the hedge timeline depend on an entry-form detail. With fut_qty on the
  // expensive leg the hedge went on early; parked on the cheap leg (placed
  // last under premium priority) the entire spread filled with NO hedge and
  // all of it arrived in one lump at the end. Same structure, same size,
  // completely different exposure. Each leg still contributes its own fut_qty,
  // just scaled by the shared ratio, so the totals come out identical either way.
  async function syncLegHedge({ accountId, currency, h, progress, settled, legLabel }) {
    if (!h.futInst || !h.futQty) return true;
    const totalFut = Math.abs(h.futQty);

    const credit = (coin, price) => {
      if (!(coin > 0)) return;
      h.hedged   = (h.hedged || 0) + coin;
      h.weighted = (h.weighted || 0) + coin * (parseFloat(price) || 0);
    };

    if (h.orderId) {
      const d = await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${h.orderId}`)
        .then(r => r.json()).catch(() => ({}));
      const placed = h.orderCoin || 0;
      const frac = parseFloat(d.amount) > 0 ? (parseFloat(d.filled_amount) || 0) / parseFloat(d.amount) : 0;

      if (d.order_state === "filled") {
        credit(placed, d.price);
        addComboLog(`${legLabel} hedge filled ${placed} @ ${d.price} (maker)`);
        h.orderId = null; h.orderCoin = 0;
      } else if (d.order_state === "cancelled" || d.order_state === "rejected") {
        credit(placed * frac, d.price);
        h.orderId = null; h.orderCoin = 0;
      } else {
        const fD = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=futures&instrument=${encodeURIComponent(h.futInst)}`)
          .then(r => r.json()).catch(() => ({}));
        const touch = h.futDir === "buy" ? fD.best_bid : fD.best_ask;
        if (touch > 0 && h.orderPrice > 0 && Math.abs(touch - h.orderPrice) > 1e-9) {
          const cRes = await fetch(`/api/deribit-order?account_id=${accountId}&order_id=${h.orderId}`, { method: "DELETE" });
          const cD   = await cRes.json().catch(() => ({}));
          if (!cRes.ok) return false; // cancel failed — retry rather than risk a duplicate
          const cFrac = parseFloat(cD.amount) > 0 ? (parseFloat(cD.filled_amount) || 0) / parseFloat(cD.amount) : frac;
          credit(placed * cFrac, cD.price);
          h.orderId = null; h.orderCoin = 0;
        } else {
          return false; // resting at the right price
        }
      }
    }

    const startAll  = (progress || []).reduce((sum, x) => sum + (x?.total  || 0), 0);
    const filledAll = (progress || []).reduce((sum, x) => sum + (x?.filled || 0), 0);
    const ratio  = startAll > 0 ? Math.min(1, filledAll / startAll) : 1;
    const need   = totalFut * ratio - (h.hedged || 0);
    if (need <= 1e-9) return settled || (ratio >= 1 && (h.hedged || 0) >= totalFut - 1e-9);
    if (settled && need < totalFut * 0.01) {
      addComboLog(`${legLabel} remaining hedge ${need.toFixed(6)} is negligible — finishing.`);
      return true;
    }

    const fD = await fetch(`/api/market?account_id=${accountId}&token=${currency}&action=futures&instrument=${encodeURIComponent(h.futInst)}`)
      .then(r => r.json()).catch(() => ({}));
    const touch = h.futDir === "buy" ? fD.best_bid : fD.best_ask;
    if (!(touch > 0)) return false;

    const data = await fetch("/api/deribit-order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId, instrument: h.futInst, qty: need,
        direction: h.futDir, price: touch, is_market: false, post_only: true,
      }),
    }).then(r => r.json()).catch(() => ({}));
    if (!data.order_id) {
      addComboLog(`${legLabel} hedge order failed: ${data.error || "unknown"} — will retry.`);
      return false;
    }
    addComboLog(`${legLabel} hedging ${need.toFixed(6)} (structure ${(ratio * 100).toFixed(0)}% filled) — maker ${h.futDir} @ ${touch}`);
    h.orderId = data.order_id; h.orderPrice = touch; h.orderCoin = need;
    return false;
  }

  // Works a leg's hedge to completion once its option side has settled —
  // whether it filled fully or was stopped part-way.
  async function settleLegHedge({ accountId, currency, h, progress, legLabel }) {
    if (!h.futInst || !h.futQty) return null;
    for (let i = 0; i < 150; i++) { // ~5 min ceiling, then hand back what's done
      const done = await syncLegHedge({ accountId, currency, h, progress, settled: true, legLabel });
      if (done) break;
      await sleep(2000);
    }
    return h.hedged > 0 && h.weighted > 0 ? h.weighted / h.hedged : null;
  }

  async function handleExecute() {
    setExecuteError(null); setExecuteResult(null); setComboEntryLogs([]);
    if (!selectedAcct) { setExecuteError("Select an account first."); return; }
    // Lock in the group_id now, before anything else — the auto-close job
    // (created right after execution completes) and any later "Save
    // Strategy" must share the exact same value, or the Monitor page can
    // never find the job for a saved leg. Without this, a brand-new (not
    // edit-mode) strategy would get one group_id for the job (generated
    // here at execute time) and a completely different one for the saved
    // trades (generated independently, later, by saveStrategies) — leaving
    // a live, unmonitored position with an orphaned job nobody can find.
    if (!comboGroupIdRef.current) comboGroupIdRef.current = editGroup || `combined_${Date.now()}`;
    comboCancelRef.current = false;
    setComboEntryPhase("running");
    setExecuting(true);
    const filledLegs = [];
    try {
      // Freeze account balance into each leg's Investment field before placing orders
      const tokenSet = new Set(legs.map(l => (l.form.token || "ETH").toUpperCase()).filter(Boolean));
      const balances = {};
      await Promise.all([...tokenSet].map(async (currency) => {
        try {
          const r = await fetch(`/api/balance?account_id=${selectedAcct}&currency=${currency}`);
          const d = await r.json();
          if (r.ok && d.equity != null) balances[currency] = d.equity;
        } catch { /* non-fatal */ }
      }));
      legs.forEach((leg, i) => {
        const currency = (leg.form.token || "ETH").toUpperCase();
        if (balances[currency] != null) setLegBulk(i, { investment: String(balances[currency]) });
      });

      // Build + validate every leg's plan up front — fail fast before
      // placing anything, and so both phases below can address legs by a
      // stable index.
      const plans = [];
      legs.forEach((leg, i) => {
        const optQty = parseFloat(leg.form.opt_entry_qty) || 0;
        const futQty = parseFloat(leg.form.fut_qty) || 0;
        if (optQty === 0 && futQty === 0) return;
        const optInst = buildDeribitInst(leg.form.token, leg.form.expiry, leg.form.options_strike, leg.form.option_type);
        const futInst = buildFuturesInst(leg.form.token, leg.form.fut_instrument_type);
        if (optQty !== 0 && !optInst) throw new Error(`Leg ${i + 1}: Select expiry and strike to determine the option instrument.`);
        plans.push({ i, leg, optQty, futQty, currency: (leg.form.token || "ETH").toUpperCase(), optInst, futInst });
      });

      // One hedge state per leg, created BEFORE phase 1 and mutated in place
      // as the option fills. Holding it out here is what lets phase 2 still
      // see how much a leg filled even when that leg threw (stopped, errored)
      // — the case that previously left a filled option with no hedge at all.
      const hedges = plans.map(p => ({
        futInst: p.futInst, futQty: p.futQty,
        futDir: p.futQty > 0 ? "buy" : "sell",
        hedged: 0, weighted: 0, orderId: null, orderPrice: 0, orderCoin: 0, filledOpt: 0,
      }));

      // Shared fill tally for the whole structure — every option leg reports
      // into it, and the hedge ratio is read from it. A futures-only leg
      // (optQty 0) contributes nothing, so it can't dilute the ratio.
      const progress = plans.map(p => ({ filled: 0, total: Math.abs(p.optQty) }));

      // Phase 1 — each SPREAD works in parallel, but the legs INSIDE a spread
      // go in sequence, most expensive premium first.
      //
      // The expensive leg is the one that must not be missed: filling a 3.36
      // short before its 27.00 long leaves the risky half of the spread naked
      // at a fraction of the value, and the cheap leg is far easier to fill
      // afterwards than the expensive one is to chase alone. So the high
      // premium gets the market to itself, and its partner is only placed once
      // it has actually filled.
      //
      // Calls and puts still run concurrently — they are separate spreads, so
      // holding one behind the other would only add drift for no protection.
      const premiumOf = (p) => Math.abs(parseFloat(p.leg.form.opt_entry_price) || 0);
      const spreadKeyOf = (p) => (p.leg.form.option_type
        || (String(p.leg.type).startsWith("CALL") ? "CALL" : "PUT"));

      const spreads = {};
      plans.forEach((p, idx) => {
        if (p.optQty === 0) return;               // futures-only leg, nothing to sequence
        const k = spreadKeyOf(p);
        (spreads[k] = spreads[k] || []).push({ p, idx });
      });
      // Highest premium first within each spread.
      Object.values(spreads).forEach(list => list.sort((a, b) => premiumOf(b.p) - premiumOf(a.p)));

      // Pre-seeded so legs skipped (futures-only, or blocked by a failed
      // partner) still line up with plans by index for phase 2.
      const optOutcomes = plans.map(() => ({ status: "fulfilled", value: null }));

      Object.entries(spreads).forEach(([k, list]) => {
        addComboLog(`${k} spread order: ${list.map(({ p }) => `Leg ${p.i + 1} @ ${premiumOf(p)}`).join(" → ")}`);
      });

      await Promise.all(Object.entries(spreads).map(async ([k, list]) => {
        for (let n = 0; n < list.length; n++) {
          const { p, idx } = list[n];
          const waiting = list.slice(n + 1).map(({ p: q }) => `Leg ${q.i + 1}`);
          addComboLog(
            `Leg ${p.i + 1} (${p.leg.type}) premium ${premiumOf(p)}: placing option` +
            (waiting.length ? ` — ${waiting.join(", ")} held until this fills` : "")
          );
          try {
            const value = await runLegOptionEntry({
              accountId: selectedAcct, currency: p.currency, optInst: p.optInst, optQty: p.optQty,
              h: hedges[idx], legLabel: `Leg ${p.i + 1}`, blocking: waiting,
              progress, progressIdx: idx,
            });
            optOutcomes[idx] = { status: "fulfilled", value };
          } catch (e) {
            optOutcomes[idx] = { status: "rejected", reason: e };
            // Deliberately do NOT place the cheaper leg. Its only purpose is to
            // offset the expensive one; on its own it is naked risk at a
            // fraction of the premium, which is worse than not entering.
            if (waiting.length) {
              addComboLog(`Leg ${p.i + 1} did not fill (${e.message}) — holding ${waiting.join(", ")}, ${k} spread not entered.`);
            }
            break;
          }
        }
      }));

      // Phase 2 — finish each leg's hedge against what its option ACTUALLY
      // filled. A leg that threw is no longer skipped: if part of it filled,
      // that part still gets hedged, because abandoning it would leave a live
      // short option naked. A leg that filled nothing needs nothing.
      addComboLog(`Completing futures hedges against actual option fills...`);
      const futOutcomes = await Promise.allSettled(plans.map(async (p, idx) => {
        const h = hedges[idx];
        if (!h.futInst || p.futQty === 0) return null;
        // Nothing anywhere in the structure filled — hedging would create
        // naked futures exposure against options that don't exist.
        const anyFilled = progress.some(x => x.filled > 0);
        const hasOptions = progress.some(x => x.total > 0);
        if (hasOptions && !anyFilled) {
          addComboLog(`Leg ${p.i + 1}: no option filled anywhere — no hedge needed.`);
          return null;
        }
        // A futures-only structure (no option legs at all) hedges in full:
        // ratio falls back to 1 when there is nothing to measure against.
        return await settleLegHedge({
          accountId: selectedAcct, currency: p.currency, h,
          progress, legLabel: `Leg ${p.i + 1}`,
        });
      }));

      plans.forEach((p, idx) => {
        const optFillPrice = optOutcomes[idx].status === "fulfilled" ? optOutcomes[idx].value : null;
        const futFillPrice = futOutcomes[idx].status === "fulfilled" ? futOutcomes[idx].value : null;
        filledLegs.push({
          legType: p.leg.type,
          optInst: p.optInst, optQty: p.optQty, optDir: p.optQty > 0 ? "sell" : "buy", optFillPrice,
          futInst: p.futInst, futQty: p.futQty, futDir: p.futQty > 0 ? "sell" : "buy", futFillPrice,
        });
        setLegBulk(p.i, {
          ...(optFillPrice != null ? { opt_entry_price: optFillPrice.toFixed(4) } : {}),
          ...(futFillPrice != null ? { fut_entry_price: String(futFillPrice) } : {}),
        });
      });

      comboFilledLegsRef.current = filledLegs;
      setExecuteResult(filledLegs);

      const failedLegs = plans.filter((p, idx) =>
        (p.optQty !== 0 && optOutcomes[idx].status === "rejected") ||
        (p.futQty !== 0 && optOutcomes[idx].status !== "rejected" && futOutcomes[idx].status === "rejected")
      );
      if (failedLegs.length) {
        failedLegs.forEach((p, idx) => {
          const optErr = optOutcomes[plans.indexOf(p)].status === "rejected" ? optOutcomes[plans.indexOf(p)].reason?.message || optOutcomes[plans.indexOf(p)].reason : null;
          const futErr = futOutcomes[plans.indexOf(p)].status === "rejected" ? futOutcomes[plans.indexOf(p)].reason?.message || futOutcomes[plans.indexOf(p)].reason : null;
          addComboLog(`Leg ${p.i + 1} FAILED — ${optErr || futErr}`);
        });
        setComboEntryPhase("error");
        setExecuteError(
          `Leg${failedLegs.length > 1 ? "s" : ""} ${failedLegs.map(p => p.i + 1).join(", ")} failed. ` +
          `Successfully filled legs were entered and hedged — check the log above and retry the failed leg(s) manually.`
        );
      } else {
        setComboEntryPhase("done");
      }
    } catch (e) {
      setExecuteError(e.message);
      setComboEntryPhase("error");
    } finally {
      setExecuting(false);
    }
  }

  function cancelComboExecute() {
    comboCancelRef.current = true;
    addComboLog("Cancel requested — waiting for current leg to unwind…");
  }

  /* ── Combo auto-close (server-side job spanning all legs) ───────────── */
  async function pollComboAcJob(jobId) {
    try {
      const r = await fetch(`/api/auto-close-combo?id=${jobId}`);
      const d = await r.json();
      if (d.job) {
        setComboAcJob(d);
        if (["completed", "failed", "stopped"].includes(d.job.status)) {
          clearInterval(comboAcTimerRef.current);
        }
      }
    } catch {}
  }

  async function startComboAutoClose(filledLegs) {
    setComboAcError(null);
    const legsToUse = filledLegs && filledLegs.length ? filledLegs : comboFilledLegsRef.current;
    if (!(parseFloat(comboTargetPnl) > 0)) { setComboAcError("Enter a Booking PnL Target first."); return; }
    if (!legsToUse.length) { setComboAcError("No executed legs to monitor — run Execute first."); return; }
    if (!selectedAcct) { setComboAcError("Select an account first."); return; }

    setComboAcStarting(true);
    try {
      const token   = (legs[0]?.form.token || "ETH").toUpperCase();
      const groupId = comboGroupIdRef.current || editGroup || `combined_${Date.now()}`;

      // If this group already has a PRIOR combo job — most commonly a
      // failed one (IP whitelist block, Deribit outage) — reuse ITS
      // initial collateral instead of snapshotting current equity fresh.
      // The position itself never changed; only monitoring stopped and is
      // being restarted, so the PnL baseline must stay "since the position
      // was actually entered", not "since this restart".
      let initialTotalUsd = null;
      let initialUsdcEquityUsd = null;
      let effectiveMonitorMode = comboMonitorMode;
      try {
        const priorData = await fetch(`/api/auto-close-combo?group_id=${groupId}`).then(r => r.json());
        // != null only — initial_total_usd can legitimately be 0 or
        // negative under coin-only tracking (a coin-margined wallet can go
        // negative), so a ">0" filter here would wrongly skip a real,
        // reusable baseline and silently reset it to a fresh snapshot.
        const withInitial = (priorData.jobs || [])
          .filter(j => j.initial_total_usd != null)
          .sort((a, b) => b.id - a.id)[0];
        if (withInitial) {
          initialTotalUsd = parseFloat(withInitial.initial_total_usd);
          initialUsdcEquityUsd = withInitial.initial_usdc_equity_usd != null ? parseFloat(withInitial.initial_usdc_equity_usd) : null;
          // Reuse the ORIGINAL job's mode, not whatever the UI currently
          // shows — the baseline being reused was captured under that mode.
          if (withInitial.monitor_mode) effectiveMonitorMode = withInitial.monitor_mode;
        }
      } catch { /* fall through to a fresh snapshot below */ }
      if (initialTotalUsd == null) {
        const bal = await fetch(`/api/balance?account_id=${selectedAcct}&mode=collateral&token=${token}`).then(r => r.json());
        if (bal.error) throw new Error(bal.error);
        // PnL/target tracking is coin-equity for coin-margined tokens
        // (BTC/ETH) unless the user picked "Combined" — the USDC side
        // (futures hedge collateral) is then excluded from the trigger
        // decision, only kept for reference in the alert.
        const isCoinMargined = bal.coin_symbol !== "USDC";
        const useCoinOnly = isCoinMargined && effectiveMonitorMode !== "combined";
        initialTotalUsd = useCoinOnly ? (bal.coin_equity_usd ?? 0) : (bal.total_usd ?? 0);
        initialUsdcEquityUsd = isCoinMargined ? (bal.usdc_equity ?? 0) : null;
      }

      const legsPayload = legsToUse.map(l => ({
        leg_type: l.legType,
        opt_instrument: l.optInst, opt_qty: Math.abs(l.optQty || 0), opt_dir: l.optDir, opt_entry_price: l.optFillPrice,
        fut_instrument: l.futInst, fut_qty: Math.abs(l.futQty || 0), fut_dir: l.futDir, fut_entry_price: l.futFillPrice,
      }));

      const res = await fetch("/api/auto-close-combo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id:          groupId,
          account_id:        selectedAcct,
          token,
          initial_total_usd: initialTotalUsd,
          initial_usdc_equity_usd: initialUsdcEquityUsd,
          monitor_mode:      effectiveMonitorMode,
          target_pnl:        parseFloat(comboTargetPnl),
          legs:               legsPayload,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start combo auto-close job");

      clearInterval(comboAcTimerRef.current);
      pollComboAcJob(data.id);
      comboAcTimerRef.current = setInterval(() => pollComboAcJob(data.id), 5000);
    } catch (e) {
      setComboAcError(e.message);
    } finally {
      setComboAcStarting(false);
    }
  }

  async function stopComboAutoClose() {
    if (!comboAcJob?.job?.id) return;
    try {
      await fetch(`/api/auto-close-combo?id=${comboAcJob.job.id}`, { method: "DELETE" });
      pollComboAcJob(comboAcJob.job.id);
    } catch (e) { setComboAcError(e.message); }
  }

  // For a strategy that's already open on the exchange (saved/executed
  // earlier, no monitor running) — starts the combo job directly off the
  // currently-loaded leg data, WITHOUT placing any new orders. Edit mode
  // only, since it needs entry prices/qty that only exist for a saved leg.
  function startMonitorForExisting() {
    const filled = legs.map((leg) => {
      const optQty = parseFloat(leg.form.opt_entry_qty) || 0;
      const futQty = parseFloat(leg.form.fut_qty) || 0;
      return {
        legType: leg.type,
        optInst: buildDeribitInst(leg.form.token, leg.form.expiry, leg.form.options_strike, leg.form.option_type),
        optQty, optDir: optQty > 0 ? "sell" : "buy", optFillPrice: parseFloat(leg.form.opt_entry_price) || null,
        futInst: buildFuturesInst(leg.form.token, leg.form.fut_instrument_type),
        futQty, futDir: futQty > 0 ? "sell" : "buy", futFillPrice: parseFloat(leg.form.fut_entry_price) || null,
      };
    }).filter(l => l.optQty !== 0 || l.futQty !== 0);
    comboFilledLegsRef.current = filled;
    startComboAutoClose(filled);
  }

  async function handleExecuteAndAutoClose() {
    if (!(parseFloat(comboTargetPnl) > 0)) { setComboAcError("Enter a Booking PnL Target first."); return; }
    setComboAcError(null);
    setComboAutoCloseAfterEntry(true);
    await handleExecute();
  }

  // Places the legs and stops there — no target required, no monitor started.
  // The flag is cleared explicitly rather than assumed false: it persists on
  // the component, so a previous "Execute + Auto-Close" click that errored out
  // could otherwise leave it set and silently start a monitor off this run.
  async function handleExecuteOnly() {
    setComboAcError(null);
    setComboAutoCloseAfterEntry(false);
    await handleExecute();
  }

  /* ── Save handlers ──────────────────────────────────── */
  async function saveStrategies() {
    setSaving(true); setSaveMsg(null); setSaveErr(null);
    try {
      // Reuse the group_id an already-run Execute locked in, so the saved
      // trades line up with whatever auto-close job was created for them —
      // only generate a fresh one if this strategy was never executed.
      const groupId = comboGroupIdRef.current || `combined_${Date.now()}`;
      comboGroupIdRef.current = groupId;
      const ids = await Promise.all(legs.map((leg) =>
        fetch("/api/options/trades", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...leg.form, group_id: groupId, account_id: selectedAcct || undefined }),
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
        const acctPatch = selectedAcct ? { account_id: selectedAcct } : {};
        return id
          ? fetch(`/api/options/trades/${id}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...leg.form, group_id: editGroup, ...acctPatch }),
            }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error); })
          : fetch("/api/options/trades", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...leg.form, group_id: editGroup, ...acctPatch }),
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
          body: JSON.stringify({ ...payload, group_id: newGroupId, account_id: selectedAcct || undefined }),
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
          {legDisplayOrder.map((idx, pos) => (
            <span key={idx} className={`rounded-full px-3 py-0.5 text-xs font-bold border ${LEG_STYLES[legs[idx].type].badge}`}>
              {pos > 0 && <span className="mr-1.5 text-slate-300">+</span>}{legs[idx].type}
            </span>
          ))}
        </div>
        {isEditMode && (
          <span className="ml-auto rounded-full bg-violet-100 px-3 py-0.5 text-xs font-bold text-violet-700">
            Editing group: {editGroup}
          </span>
        )}
      </header>

      {/* ── Account bar ── */}
      <div className="flex items-center gap-3 border-b border-slate-100 bg-white px-6 py-3 flex-wrap shadow-sm">
        <label className="text-sm font-semibold text-slate-600 whitespace-nowrap">Exchange Account</label>
        <select
          value={selectedAcct}
          onChange={e => {
            setSelectedAcct(e.target.value);
            if (typeof window !== "undefined") localStorage.setItem("options_last_account", e.target.value);
          }}
          className="flex-1 min-w-48 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">— Manual entry (no live data) —</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.exchange}{a.testnet ? " (Testnet)" : ""}
            </option>
          ))}
        </select>
        <a href="/accounts" target="_blank"
          className="text-xs text-blue-600 hover:underline whitespace-nowrap">
          Manage Accounts
        </a>
        <button
          onClick={refreshAllLegs}
          disabled={refreshingAll || !selectedAcct}
          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {refreshingAll ? "⏳ Refreshing…" : "↺ Refresh Live (All Legs)"}
        </button>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Target PnL ($)</label>
          <input
            type="number" step="any" min="0" placeholder="e.g. 10"
            value={comboTargetPnl}
            onChange={e => setComboTargetPnl(e.target.value)}
            className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
        {!!(legs[0]?.form.token && !/_USDC$|_USDT$/i.test(legs[0].form.token)) && (
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Monitor</label>
            <select
              value={comboMonitorMode}
              onChange={e => setComboMonitorMode(e.target.value)}
              title="Coin Equity Only: ignores the USDC/futures-hedge side entirely. Combined: sums coin + USDC equity, like the original behavior."
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="coin">Coin Equity Only</option>
              <option value="combined">Combined (Coin + USDC)</option>
            </select>
          </div>
        )}
        <button
          onClick={handleExecuteOnly}
          disabled={executing || comboAcStarting || !selectedAcct}
          title="Place all legs only — no Booking PnL Target needed. Start the monitor separately whenever you're ready."
          className="rounded-lg bg-slate-700 px-5 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {executing && !comboAutoCloseAfterEntry ? `Executing ${legs.length} legs…` : `Execute (${legs.length} legs)`}
        </button>
        <button
          onClick={handleExecuteAndAutoClose}
          disabled={executing || comboAcStarting || !selectedAcct}
          className="rounded-lg bg-orange-600 px-5 py-2 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50 transition-colors whitespace-nowrap"
        >
          {executing && comboAutoCloseAfterEntry ? `Executing ${legs.length} legs in parallel…` : comboAcStarting ? "Starting Monitor…" : `⚡ Execute + Auto-Close (${legs.length} legs)`}
        </button>
        {comboEntryPhase === "running" && (
          <button onClick={cancelComboExecute}
            className="rounded-lg bg-red-600 px-5 py-2 text-sm font-bold text-white shadow hover:bg-red-700 whitespace-nowrap">
            ■ STOP
          </button>
        )}
        {isEditMode && !comboAcJob?.job && (
          <button
            onClick={startMonitorForExisting}
            disabled={comboAcStarting || executing || !selectedAcct || !(parseFloat(comboTargetPnl) > 0)}
            title="Starts monitoring this ALREADY-open position using its saved entry prices — places no new orders"
            className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {comboAcStarting ? "Starting…" : "▶ Start Monitor Only (no new orders)"}
          </button>
        )}
      </div>

      {(executeError || comboAcError) && (
        <div className="mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{executeError || comboAcError}</div>
      )}
      {executeResult && comboEntryPhase === "done" && (
        <div className="mx-6 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 space-y-1">
          <p className="font-semibold">All Legs Executed Successfully</p>
          {executeResult.map((r, i) => (
            <div key={i} className="text-xs">
              <span className="font-medium">Leg {i + 1} ({r.legType})</span>
              {r.optInst && <span> · Opt {r.optInst} @ {r.optFillPrice != null ? `$${r.optFillPrice.toFixed(4)}` : "—"}</span>}
              {r.futInst && r.futQty !== 0 && <span> · Fut {r.futInst} @ {r.futFillPrice != null ? `$${r.futFillPrice}` : "—"}</span>}
            </div>
          ))}
        </div>
      )}
      {comboEntryLogs.length > 0 && (
        <div className="mx-6 mt-3 rounded-lg bg-slate-900 p-3 max-h-40 overflow-y-auto font-mono text-xs text-slate-300 space-y-0.5">
          {comboEntryLogs.map((l, i) => (
            <div key={i} className={
              l.includes("failed") || l.includes("Error") ? "text-red-400"
              : l.includes("filled") || l.includes("Filled") ? "text-emerald-400"
              : l.includes("→") ? "text-yellow-300"
              : ""
            }>{l}</div>
          ))}
        </div>
      )}

      {/* ── Combo Auto-Close status ── */}
      {comboAcJob?.job && (
        <div className="mx-6 mt-3 rounded-xl border border-blue-200 bg-white p-4 shadow-sm space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-bold text-slate-800">Combo Auto-Close — Job #{comboAcJob.job.id}</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold border ${
              comboAcJob.job.status === "completed" ? "bg-emerald-100 text-emerald-700 border-emerald-200"
              : comboAcJob.job.status === "failed"  ? "bg-red-100 text-red-700 border-red-200"
              : comboAcJob.job.status === "stopped" ? "bg-slate-100 text-slate-500 border-slate-200"
              : "bg-orange-100 text-orange-700 border-orange-200 animate-pulse"
            }`}>
              {comboAcJob.job.status.toUpperCase()}
            </span>
          </div>

          {comboAcJob.job.last_equity_usd != null && (() => {
            const pnl = parseFloat(comboAcJob.job.last_equity_usd) - parseFloat(comboAcJob.job.initial_total_usd);
            const tgt = parseFloat(comboAcJob.job.target_pnl);
            const pct = tgt > 0 ? Math.min(100, Math.max(0, (pnl / tgt) * 100)) : 0;
            return (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Initial: ${parseFloat(comboAcJob.job.initial_total_usd).toFixed(2)}</span>
                  <span className={`font-bold ${pnl >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    PnL: {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} / +${tgt.toFixed(2)} target
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })()}

          {comboAcJob.legs?.length > 0 && (
            <div className="space-y-1 text-xs text-slate-600">
              {comboAcJob.legs.map(leg => (
                <div key={leg.id} className="flex items-center gap-2">
                  <span className="font-medium">Leg {leg.leg_index + 1} ({leg.leg_type || "?"}):</span>
                  <span>{leg.opt_instrument}</span>
                  <span className={leg.opt_done ? "text-emerald-600" : "text-slate-400"}>{leg.opt_done ? "✓ opt closed" : "opt pending"}</span>
                  {leg.fut_instrument && (
                    <span className={leg.fut_done ? "text-emerald-600" : "text-slate-400"}>{leg.fut_done ? "✓ fut closed" : "fut pending"}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {["active", "closing"].includes(comboAcJob.job.status) && (
            <button onClick={stopComboAutoClose}
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors">
              ■ Stop Combo Auto-Close
            </button>
          )}

          {comboAcJob.job.logs?.length > 0 && (
            <div className="rounded-lg bg-slate-900 p-3 max-h-40 overflow-y-auto font-mono text-xs text-slate-300 space-y-0.5">
              {[...comboAcJob.job.logs].reverse().map((l, i) => (
                <div key={i} className={
                  l.includes("TARGET") || l.includes("filled") || l.includes("Complete") ? "text-emerald-400"
                  : l.includes("error") || l.includes("Error") ? "text-red-400"
                  : ""
                }>{l}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {loadErr && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadErr}</div>
      )}

      <div className="p-6 space-y-6">
        {/* ── Leg cards ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {legDisplayOrder.map((idx) => {
            const leg = legs[idx];
            return (
              <LegCard
                key={idx}
                ref={el => { legRefs.current[idx] = el; }}
                label={`Leg ${idx + 1}`}
                legType={leg.type}
                onLegTypeChange={(t) => changeLegType(idx, t)}
                form={leg.form}
                set={(k, v) => setLegField(idx, k, v)}
                setBulk={(updates) => setLegBulk(idx, updates)}
                isSyncMaster={idx === masterLegIdx}
                syncOverrides={leg.overrides || {}}
                onRelinkField={(k) => relinkLegField(idx, k)}
                derived={deriveds[idx] || {}}
                canRemove={legs.length > 2}
                onRemove={() => removeLeg(idx)}
                accountId={selectedAcct}
              />
            );
          })}

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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <SummaryCard label="Total Investment" value={fmtCcy(totalInvestment)} color="blue" />
            <SummaryCard label="Booked PnL"       value={fmtCcy(bookedPnl)}       color={bookedPnl >= 0 ? "green" : "red"} />
            <SummaryCard label="MM PL"            value={fmtCcy(mmPl)}            color={mmPl >= 0 ? "green" : "red"} />
            <SummaryCard label="Combined APY"     value={combinedApy != null ? `${combinedApy.toFixed(2)}%` : "—"} color="purple" />
            <SummaryCard label="Total Theta"      value={fmtCcy(combinedTotalTheta)}  color={combinedTotalTheta  >= 0 ? "green" : "red"} />
            <SummaryCard label="Per Day Theta"    value={fmtCcy(combinedPerDayTheta)} color={combinedPerDayTheta >= 0 ? "green" : "red"} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <ScenarioBlock title="📈 Upside Scenario"   legs={legs} perLeg={upside.byLeg}   totals={upside}   scenario="up"   bsToday={bsUpsideCombined} />
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
                  { label: "Total Theta",       key: "total_theta_gain_loss",      total: combinedTotalTheta,  bold: true },
                  { label: "Per Day Theta",     key: "per_day_theta_gain_loss",    total: combinedPerDayTheta, bold: true },
                  { label: "Upside Opt PnL",    key: "upside_opt_pnl",             total: upside.opt   },
                  { label: "Down Opt PnL",       key: "down_opt_pnl",               total: downside.opt },
                  { label: "Upside Fut PnL",     key: "upside_fut_pnl",             total: upside.fut   },
                  { label: "Down Fut PnL",       key: "downside_fut_pnl",           total: downside.fut },
                  { label: "MM Loss",            key: "total_mm_loss",              total: upside.mm    },
                  { label: "Est. Net (Up)",      key: "estimated_upside_net_pnl",   total: upside.net,   bold: true },
                  { label: "Est. Net (Down)",    key: "estimated_downside_net_pnl", total: downside.net, bold: true },
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

const LegCard = forwardRef(function LegCard({ label, legType, onLegTypeChange, form, set, setBulk, derived, canRemove, onRemove, accountId, isSyncMaster = false, syncOverrides = {}, onRelinkField }, ref) {
  const inp   = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";
  const style = LEG_STYLES[legType];

  // Label for a field that follows the first card: marks the source, and on a
  // follower that was edited directly shows it's gone custom with a way back.
  const isOverridden = (key) => !isSyncMaster && !!syncOverrides[key];
  const syncLabel = (key, title) => (
    <span className="flex items-center gap-1.5">
      {title}
      {isSyncMaster && <span className="text-[10px] font-normal text-blue-600">applies to all legs</span>}
      {isOverridden(key) && (
        <>
          <span className="text-[10px] font-normal text-amber-600">custom</span>
          <button
            type="button"
            onClick={() => onRelinkField?.(key)}
            title="Follow the first leg's value again"
            className="text-[10px] text-slate-400 hover:text-blue-600 underline"
          >
            re-link
          </button>
        </>
      )}
    </span>
  );
  const syncCls = (key) => (isOverridden(key) ? "border-amber-300 bg-amber-50" : "");

  // Per-leg live data state
  const [liveExpiries,   setLiveExpiries]   = useState([]);
  const [loadingChain,   setLoadingChain]   = useState(false);
  const [chainError,     setChainError]     = useState(null);
  const [tickerInfo,     setTickerInfo]     = useState(null);
  const [fetchingTicker, setFetchingTicker] = useState(false);
  const chainTimerRef = useRef(null);
  // When true, saved DB values are preserved — auto-populating from live data won't overwrite them.
  // Set when form is loaded from DB (token changes from empty → value with saved data).
  // Cleared when user explicitly changes expiry, strike, or token.
  const preserveRef  = useRef(false);
  const prevTokenRef = useRef("");
  // Token field: dropdown of known tokens, or manual free-text entry for
  // anything else. Switches into manual mode whenever the token (including
  // one loaded async from a saved DB record) isn't one of the known presets.
  const [manualToken, setManualToken] = useState(false);
  useEffect(() => {
    if (form.token && !KNOWN_TOKENS.some(t => t.value === form.token)) setManualToken(true);
  }, [form.token]);

  // Net Booked PnL = Futures PnL + Options PnL + Market Making PL — always
  // derived, never typed directly. Recomputes whenever any of the three
  // inputs change; stays blank until at least one of them has a value.
  useEffect(() => {
    const { fut_pnl, opt_pnl, market_making_pl } = form;
    if (fut_pnl === "" && opt_pnl === "" && market_making_pl === "") {
      if (form.net_booked_pnl !== "") setBulk({ net_booked_pnl: "" });
      return;
    }
    const n = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
    const computed = n(fut_pnl) + n(opt_pnl) + n(market_making_pl);
    if (String(computed) !== String(form.net_booked_pnl)) setBulk({ net_booked_pnl: computed });
  }, [form.fut_pnl, form.opt_pnl, form.market_making_pl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect DB load: token changed from empty → saved value that already has expiry/price data.
  useEffect(() => {
    const wasEmpty = !prevTokenRef.current;
    const hasData  = !!(form.token && form.expiry && (form.opt_entry_price || form.fut_entry_price));
    if (wasEmpty && hasData) preserveRef.current = true;
    prevTokenRef.current = form.token;
  }, [form.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch chain when account + token changes
  useEffect(() => {
    clearTimeout(chainTimerRef.current);
    if (!accountId || !form.token || form.token.trim().length < 2) {
      setLiveExpiries([]); setTickerInfo(null); setChainError(null); return;
    }
    const token = form.token.trim().toUpperCase();
    chainTimerRef.current = setTimeout(async () => {
      setLoadingChain(true); setLiveExpiries([]); setTickerInfo(null); setChainError(null);
      try {
        const res  = await fetch(`/api/market?account_id=${accountId}&token=${token}&action=chain`);
        const data = await res.json();
        if (!res.ok) { setChainError(data.error || `HTTP ${res.status}`); return; }
        if (data.expiries?.length) {
          setLiveExpiries(data.expiries);
          // Only auto-select first expiry/clear strike when NOT preserving saved values
          if (!preserveRef.current) {
            setBulk({ expiry: data.expiries[0].date, options_strike: "" });
          }
          fetch(`/api/market?account_id=${accountId}&token=${token}&action=futures&instrument=${encodeURIComponent(buildFuturesInst(token, form.fut_instrument_type))}`)
            .then(r => r.json())
            .then(d => {
              if (d.mark_price) {
                const upd = { fut_mid_price: String(d.mid_price ?? d.mark_price) };
                // Only overwrite the displayed fut_entry_price when NOT preserving
                if (!preserveRef.current) upd.fut_entry_price = String(d.mark_price);
                setBulk(upd);
              }
            })
            .catch(() => {});
        } else {
          setChainError(data.error || `No active options found for ${token} on Deribit`);
        }
      } catch (e) {
        setChainError(e.message);
      } finally { setLoadingChain(false); }
    }, 700);
    return () => clearTimeout(chainTimerRef.current);
  }, [accountId, form.token]);

  // Auto-fetch ticker when expiry/strike/option_type changes (live mode)
  useEffect(() => {
    if (!accountId || !liveExpiries.length || !form.options_strike || !form.expiry) return;
    const token = (form.token || "ETH").toUpperCase();
    const inst  = buildDeribitInst(token, form.expiry, form.options_strike, form.option_type);
    if (!inst) return;
    let cancelled = false;
    setFetchingTicker(true); setTickerInfo(null);
    fetch(`/api/market?account_id=${accountId}&token=${token}&action=ticker&instrument=${encodeURIComponent(inst)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled || !data.mark_price_usd) return;
        setTickerInfo({ ...data, instrument: inst });
        // Always update execution prices (mid_price_raw, iv); only update display price if NOT preserving
        const upd = {
          iv:                data.mark_iv != null ? String(Math.round(data.mark_iv * 10) / 10) : form.iv,
          opt_mid_price_raw: String(data.mid_price_raw ?? data.mark_price_raw ?? ""),
        };
        if (!preserveRef.current) upd.opt_entry_price = fmtOptPrice(data.mark_price_usd, data);
        setBulk(upd);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setFetchingTicker(false); });
    return () => { cancelled = true; };
  }, [form.expiry, form.options_strike, form.option_type, accountId, liveExpiries.length]);

  async function refreshTicker() {
    preserveRef.current = false; // User explicitly asked for live price — always override
    const token   = (form.token || "ETH").toUpperCase();
    const inst    = buildDeribitInst(token, form.expiry, form.options_strike, form.option_type);
    const futInst = buildFuturesInst(token, form.fut_instrument_type);
    if (!accountId) return;
    setFetchingTicker(true);
    try {
      const [optRes, futRes] = await Promise.all([
        inst ? fetch(`/api/market?account_id=${accountId}&token=${token}&action=ticker&instrument=${encodeURIComponent(inst)}`) : Promise.resolve(null),
        fetch(`/api/market?account_id=${accountId}&token=${token}&action=futures&instrument=${encodeURIComponent(futInst)}`),
      ]);
      const [optData, futData] = await Promise.all([
        optRes ? optRes.json() : Promise.resolve(null),
        futRes.json(),
      ]);

      const update = {};
      if (optRes && optRes.ok && optData?.mark_price_usd != null) {
        setTickerInfo({ ...optData, instrument: inst });
        update.opt_entry_price   = fmtOptPrice(optData.mark_price_usd, optData);
        update.iv                = optData.mark_iv != null ? String(Math.round(optData.mark_iv * 10) / 10) : form.iv;
        update.opt_mid_price_raw = String(optData.mid_price_raw ?? optData.mark_price_raw ?? "");
      }
      if (futRes.ok && futData?.mark_price != null) {
        update.fut_entry_price = String(Math.round(futData.mark_price * 100) / 100);
        update.fut_mid_price   = String(futData.mid_price ?? futData.mark_price ?? "");
      }
      if (Object.keys(update).length) setBulk(update);
    } finally { setFetchingTicker(false); }
  }

  // Exposes this leg's own refresh to the parent, so a single "Refresh All
  // Legs" button can trigger every card's live update without duplicating
  // the fetch logic in the parent.
  useImperativeHandle(ref, () => ({ refreshTicker }));

  const liveExpiryObj = liveExpiries.find(e => e.date === form.expiry) || null;
  const liveStrikes   = liveExpiryObj?.strikes || [];
  const hasLiveData   = liveExpiries.length > 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex-wrap">
        <span className="text-sm font-bold text-slate-600">{label}</span>
        <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${style.badge}`}>
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          <select value={legType} onChange={(e) => onLegTypeChange(e.target.value)}
            className="bg-transparent text-xs font-bold outline-none cursor-pointer">
            {LEG_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        {hasLiveData && !loadingChain && (
          <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-xs font-semibold text-emerald-700">
            ● Live
          </span>
        )}
        {loadingChain && (
          <span className="text-xs text-slate-400 animate-pulse">Loading chain…</span>
        )}
        {chainError && !loadingChain && !hasLiveData && (
          <span className="rounded-full bg-red-100 border border-red-200 px-2 py-0.5 text-xs font-semibold text-red-600" title={chainError}>
            ✕ {chainError.length > 60 ? chainError.slice(0, 60) + "…" : chainError}
          </span>
        )}
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
        <div className="grid grid-cols-2 gap-3">
          <F label={syncLabel("entry_date", "Entry Date")}><input type="date" value={form.entry_date} onChange={(e) => set("entry_date", e.target.value)} className={`${inp} ${syncCls("entry_date")}`} /></F>
          <F label={syncLabel("token", "Token")}>
            {manualToken ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder='e.g. "DOGE_USDC", "MATIC"'
                  value={form.token}
                  onChange={(e) => { preserveRef.current = false; set("token", e.target.value.toUpperCase()); }}
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
                value={KNOWN_TOKENS.some(t => t.value === form.token) ? form.token : ""}
                onChange={(e) => {
                  preserveRef.current = false;
                  if (e.target.value === "__custom__") { setManualToken(true); set("token", ""); }
                  else set("token", e.target.value);
                }}
                className={inp}
              >
                <option value="">— Select token —</option>
                {KNOWN_TOKENS.map(t => (
                  <option key={t.value} value={t.value}>{t.label} ({t.value})</option>
                ))}
                <option value="__custom__">Other (type manually)…</option>
              </select>
            )}
          </F>
          <F label="Investment"><input type="number" step="any" value={form.investment} onChange={(e) => set("investment", e.target.value)} className={inp} /></F>

          {/* Expiry — dropdown when live */}
          <F label={syncLabel("expiry", hasLiveData ? "Expiry (live)" : "Expiry Date")}>
            {hasLiveData ? (
              <select value={form.expiry} onChange={e => { preserveRef.current = false; set("expiry", e.target.value); set("options_strike", ""); }} className={inp}>
                {liveExpiries.map(e => (
                  <option key={e.date} value={e.date}>{e.label} ({e.date})</option>
                ))}
              </select>
            ) : (
              <input type="date" value={form.expiry} onChange={(e) => set("expiry", e.target.value)} className={inp} />
            )}
          </F>

          {/* Strike — dropdown when live */}
          <F label={hasLiveData ? "Strike (live)" : "Strike"}>
            {hasLiveData && liveStrikes.length > 0 ? (
              <select value={form.options_strike} onChange={e => { preserveRef.current = false; set("options_strike", e.target.value); }} className={inp}>
                <option value="">— Select strike —</option>
                {liveStrikes.map(s => (
                  <option key={s} value={String(s)}>{Number(s).toLocaleString()}</option>
                ))}
              </select>
            ) : (
              <input type="text" placeholder='e.g. "70 CALL"' value={form.options_strike} onChange={(e) => set("options_strike", e.target.value)} className={inp} />
            )}
          </F>

          <F label={syncLabel("opt_entry_qty", `Entry Qty${legType.endsWith("SHORT") ? " (negative)" : ""}`)}>
            <input type="number" step="any" value={form.opt_entry_qty} onChange={(e) => set("opt_entry_qty", e.target.value)}
              className={`${inp} ${
                isOverridden("opt_entry_qty") ? "border-amber-300 bg-amber-50"
                : legType.endsWith("SHORT") ? "border-orange-300 bg-orange-50" : ""
              }`} />
          </F>
          <F label={tickerInfo ? "Entry Price (live)" : "Entry Price"}>
            <input type="number" step="any" value={form.opt_entry_price} onChange={(e) => set("opt_entry_price", e.target.value)} className={inp} />
          </F>
          <F label="Exit Price"><input type="number" step="any" value={form.opt_exit_price} onChange={(e) => set("opt_exit_price", e.target.value)} className={inp} /></F>
          {futuresHasBothTypes(form.token) && (
            <F label="Futures Instrument">
              <select
                value={form.fut_instrument_type || "inverse"}
                onChange={(e) => { preserveRef.current = false; set("fut_instrument_type", e.target.value); }}
                className={inp}
              >
                <option value="inverse">Inverse — {(form.token || "BTC").toUpperCase()}-PERPETUAL</option>
                <option value="linear">Linear/USDC — {(form.token || "BTC").toUpperCase()}_USDC-PERPETUAL</option>
              </select>
            </F>
          )}
          <F label="Fut Qty"><input type="number" step="any" value={form.fut_qty} onChange={(e) => set("fut_qty", e.target.value)} className={inp} /></F>
          <F label={syncLabel("fut_entry_price", hasLiveData && form.fut_entry_price ? "Fut Entry Price (live)" : "Fut Entry Price")}>
            <input type="number" step="any" value={form.fut_entry_price} onChange={(e) => set("fut_entry_price", e.target.value)}
              className={`${inp} ${syncCls("fut_entry_price")}`} />
          </F>
          <F label="Fut Exit Price"><input type="number" step="any" value={form.fut_exit_price} onChange={(e) => set("fut_exit_price", e.target.value)} className={inp} /></F>
          <F label={tickerInfo ? "IV (%) (live)" : "IV (%) for BS"}>
            <input type="number" step="0.5" min="1" max="500" placeholder="e.g. 30" value={form.iv} onChange={(e) => set("iv", e.target.value)} className={`${inp} border-indigo-200 bg-indigo-50`} />
          </F>
          {[["upside_distance", "Upside Distance"], ["down_distance", "Down Distance"]].map(([key, title]) => (
            <F key={key} label={syncLabel(key, title)}>
              <input type="number" step="any" value={form[key]} onChange={(e) => set(key, e.target.value)} className={`${inp} ${syncCls(key)}`} />
            </F>
          ))}
          <F label="Basket Distance"><input type="number" step="any" value={form.basket_distance} onChange={(e) => set("basket_distance", e.target.value)} className={inp} /></F>
          <F label="Basket Loss"><input type="number" step="any" value={form.basket_loss} onChange={(e) => set("basket_loss", e.target.value)} className={inp} /></F>
          <F label="Futures PnL"><input type="number" step="any" value={form.fut_pnl} onChange={(e) => set("fut_pnl", e.target.value)} className={inp} /></F>
          <F label="Options PnL"><input type="number" step="any" value={form.opt_pnl} onChange={(e) => set("opt_pnl", e.target.value)} className={inp} /></F>
          <F label="Market Making PL"><input type="number" step="any" value={form.market_making_pl} onChange={(e) => set("market_making_pl", e.target.value)} className={inp} /></F>
          <F label="Net Booked PnL (auto)">
            <input type="number" step="any" value={form.net_booked_pnl} readOnly disabled
              className={`${inp} bg-slate-50 text-slate-500 cursor-not-allowed`}
              title="Auto-calculated: Futures PnL + Options PnL + Market Making PL" />
          </F>
          <F label={syncLabel("status", "Status")}>
            <select value={form.status} onChange={(e) => set("status", e.target.value)} className={`${inp} ${syncCls("status")}`}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </F>
          <F label={syncLabel("end_date", "End Date")}><input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className={`${inp} ${syncCls("end_date")}`} /></F>
        </div>

        {/* Refresh live price button + ticker info */}
        {hasLiveData && form.options_strike && form.expiry && (
          <div className="flex items-center gap-3 flex-wrap">
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
});

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
      {bsToday != null && (
        <>
          <div className="flex justify-between pt-2 pb-1 border-b border-dashed border-slate-200">
            <span className="text-xs font-semibold text-indigo-600">Today BS Opt {scenario === "up" ? "Upside" : "Downside"}</span>
            <span className={`text-xs font-semibold ${bsToday >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(bsToday)}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-dashed border-slate-200">
            <span className="text-xs font-semibold text-indigo-600">Today BS Fut {scenario === "up" ? "Upside" : "Downside"}</span>
            <span className={`text-xs font-semibold ${totals.fut >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(totals.fut)}</span>
          </div>
          <div className="flex justify-between py-1 border-b border-dashed border-slate-200">
            <span className="text-xs font-semibold text-indigo-600">Total MM Loss</span>
            <span className={`text-xs font-semibold ${totals.mm >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(totals.mm)}</span>
          </div>
          <div className="flex justify-between pt-2 pb-1 bg-indigo-50 -mx-4 px-4 rounded-b-lg mt-1">
            <span className="text-sm font-bold text-indigo-700">Total BS {scenario === "up" ? "Upside" : "Downside"}</span>
            <span className={`text-base font-extrabold ${(bsToday + totals.fut + totals.mm) >= 0 ? "text-emerald-600" : "text-red-600"}`}>{fmtCcy(bsToday + totals.fut + totals.mm)}</span>
          </div>
        </>
      )}
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
                : expiryPnl(S_up_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsDnToday   = hasBS && S_dn_bs > 0
    ? (T_bs > 0 ? currentPnl(S_dn_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_dn_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsToday     = hasBS && S_bs > 0
    ? (T_bs > 0 ? currentPnl(S_bs, K_bs, T_bs, RISK_FREE, sigma_bs, optType_bs, ep_bs, qty_bs)
                : expiryPnl(S_bs, K_bs, optType_bs, ep_bs, qty_bs)) : null;
  const bsBE = K_bs > 0 ? (optType_bs === "CALL" ? K_bs + ep_bs : K_bs - ep_bs) : null;

  const futUp = Number(derived?.upside_fut_pnl)   || 0;
  const futDn = Number(derived?.downside_fut_pnl) || 0;
  const mm    = Number(derived?.total_mm_loss)    || 0;
  const netUpToday  = bsUpToday != null ? bsUpToday + futUp + mm : null;
  const netDnToday  = bsDnToday != null ? bsDnToday + futDn + mm : null;
  const netUpExpiry = bsUp      != null ? bsUp      + futUp + mm : null;
  const netDnExpiry = bsDn      != null ? bsDn      + futDn + mm : null;

  return (
    <>
      <div className="my-2 border-t border-indigo-200" />
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-400 mb-1">
        📊 BS Option PNL (IV {form.iv || 30}%, {dte_bs}d)
      </p>
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

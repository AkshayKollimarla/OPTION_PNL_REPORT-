"use client";

import { useState, useMemo } from "react";
import { bsPrice } from "../lib/black-scholes";
import { strikeNumber } from "../lib/options-calculations";

const N_POINTS = 80;
const RISK_FREE = 0.05;

function normalisedTick(v) {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function priceTick(v) {
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toFixed(0);
}

function localDateStr(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function PayoffChart({ trade }) {
  const [underlying, setUnderlying] = useState("");
  const [iv,         setIv]         = useState("30");

  const K          = strikeNumber(trade.options_strike);
  const entryPrice = Math.abs(parseFloat(trade.opt_entry_price) || 0);
  const qty        = parseFloat(trade.opt_entry_qty) || 1;
  const optType    = (trade.option_type || "PUT").toUpperCase();
  const sigma      = Math.max(0.01, (parseFloat(iv) || 30) / 100);
  const S_now      = parseFloat(underlying) || K;

  // Days to expiry from today
  const expiryStr = localDateStr(trade.expiry);
  const todayStr  = localDateStr(new Date().toISOString());
  const daysLeft  = expiryStr && todayStr
    ? Math.max(0, Math.round((new Date(expiryStr) - new Date(todayStr)) / 86_400_000))
    : 0;
  const T_now = daysLeft / 365;

  const rangeMin = K * 0.60;
  const rangeMax = K * 1.40;

  const { prices, expiryLine, todayLine, oneDayLine } = useMemo(() => {
    const prices = Array.from({ length: N_POINTS + 1 }, (_, i) =>
      rangeMin + (i / N_POINTS) * (rangeMax - rangeMin)
    );

    const expiryLine = prices.map((S) => {
      const iv = optType === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
      return (iv - entryPrice) * qty;
    });

    const todayLine = prices.map((S) =>
      T_now > 0
        ? (bsPrice(S, K, T_now, RISK_FREE, sigma, optType) - entryPrice) * qty
        : expiryLine[prices.indexOf(S)]
    );

    const oneDayLine = prices.map((S) => {
      const T1 = Math.max(0, (daysLeft - 1) / 365);
      return T1 > 0
        ? (bsPrice(S, K, T1, RISK_FREE, sigma, optType) - entryPrice) * qty
        : expiryLine[prices.indexOf(S)];
    });

    return { prices, expiryLine, todayLine, oneDayLine };
  }, [K, entryPrice, qty, optType, sigma, T_now, daysLeft, rangeMin, rangeMax]);

  // SVG layout
  const W = 700, H = 300;
  const PAD = { l: 72, r: 20, t: 30, b: 52 };
  const cw  = W - PAD.l - PAD.r;
  const ch  = H - PAD.t - PAD.b;

  const allPnls  = [...expiryLine, ...todayLine, ...oneDayLine].filter(isFinite);
  const rawMin   = Math.min(...allPnls);
  const rawMax   = Math.max(...allPnls);
  const padding  = (rawMax - rawMin) * 0.08 || 1;
  const pnlMin   = rawMin - padding;
  const pnlMax   = rawMax + padding;
  const pnlRange = pnlMax - pnlMin;

  const xS = (p) => PAD.l + ((p - rangeMin) / (rangeMax - rangeMin)) * cw;
  const yS = (v) => PAD.t + ((pnlMax - v) / pnlRange) * ch;

  const toPath = (line) =>
    line
      .map((v, i) => `${i === 0 ? "M" : "L"}${xS(prices[i]).toFixed(1)},${yS(v).toFixed(1)}`)
      .join(" ");

  // Grid
  const Y_GRIDS = 5;
  const yStep   = pnlRange / Y_GRIDS;
  const yGrid   = Array.from({ length: Y_GRIDS + 1 }, (_, i) => pnlMin + i * yStep);

  const X_GRIDS = 6;
  const xStep   = (rangeMax - rangeMin) / X_GRIDS;
  const xGrid   = Array.from({ length: X_GRIDS + 1 }, (_, i) => rangeMin + i * xStep);

  const zeroY = yS(0);
  const zeroInView = zeroY >= PAD.t && zeroY <= PAD.t + ch;

  // Current price dot
  const S_inRange = S_now >= rangeMin && S_now <= rangeMax;
  const todayPnlAtCurrent = T_now > 0
    ? (bsPrice(S_now, K, T_now, RISK_FREE, sigma, optType) - entryPrice) * qty
    : expiryLine[Math.round(((S_now - rangeMin) / (rangeMax - rangeMin)) * N_POINTS)];

  return (
    <div className="rounded-xl border border-indigo-100 bg-white p-5 shadow-card space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-bold text-indigo-700 uppercase tracking-wide">Payoff Chart at Expiry</h3>
        <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-600">{optType}</span>
        <span className="text-xs text-slate-400">Strike {K.toLocaleString()} · {daysLeft}d to expiry</span>
      </div>

      {/* Inputs */}
      <div className="flex gap-4 flex-wrap items-end">
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
            Current Underlying Price
          </label>
          <input
            type="number"
            step="any"
            placeholder={K.toLocaleString()}
            value={underlying}
            onChange={(e) => setUnderlying(e.target.value)}
            className="w-44 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
            Implied Volatility (%)
          </label>
          <input
            type="number"
            step="0.5"
            min="1"
            max="500"
            value={iv}
            onChange={(e) => setIv(e.target.value)}
            className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
          />
        </div>
        <div className="pb-2 text-xs text-slate-500 space-y-0.5">
          <div>Entry price: <span className="font-semibold text-slate-700">{entryPrice.toLocaleString()}</span></div>
          <div>Qty: <span className="font-semibold text-slate-700">{qty}</span></div>
        </div>
        {underlying && (
          <div className={`pb-2 text-sm font-bold ${todayPnlAtCurrent >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            P/L at {Number(underlying).toLocaleString()}:{" "}
            {todayPnlAtCurrent >= 0 ? "+" : ""}
            {todayPnlAtCurrent.toFixed(2)}
          </div>
        )}
      </div>

      {/* SVG Chart */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-xl border border-slate-100"
        style={{ height: "auto", maxHeight: 320 }}
      >
        {/* Plot background */}
        <rect x={PAD.l} y={PAD.t} width={cw} height={ch} fill="#f8fafc" rx="4" />

        {/* Y grid */}
        {yGrid.map((y, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={yS(y)} x2={PAD.l + cw} y2={yS(y)} stroke="#e2e8f0" strokeWidth="1" />
            <text x={PAD.l - 6} y={yS(y)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="#94a3b8">
              {normalisedTick(y)}
            </text>
          </g>
        ))}

        {/* X grid */}
        {xGrid.map((x, i) => (
          <g key={i}>
            <line x1={xS(x)} y1={PAD.t} x2={xS(x)} y2={PAD.t + ch} stroke="#e2e8f0" strokeWidth="1" />
            <text x={xS(x)} y={PAD.t + ch + 15} textAnchor="middle" fontSize="10" fill="#94a3b8">
              {priceTick(x)}
            </text>
          </g>
        ))}

        {/* Zero / breakeven line */}
        {zeroInView && (
          <line x1={PAD.l} y1={zeroY} x2={PAD.l + cw} y2={zeroY}
            stroke="#475569" strokeWidth="1.5" strokeDasharray="5,4" opacity="0.5" />
        )}

        {/* Strike line */}
        <line x1={xS(K)} y1={PAD.t} x2={xS(K)} y2={PAD.t + ch}
          stroke="#8b5cf6" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.8" />
        <text x={xS(K)} y={PAD.t - 8} textAnchor="middle" fontSize="10" fill="#8b5cf6" fontWeight="600">
          K={priceTick(K)}
        </text>

        {/* Current underlying line */}
        {underlying && S_inRange && (
          <line x1={xS(S_now)} y1={PAD.t} x2={xS(S_now)} y2={PAD.t + ch}
            stroke="#0ea5e9" strokeWidth="1.5" strokeDasharray="3,3" opacity="0.8" />
        )}

        {/* Expiry P/L (orange) */}
        <path d={toPath(expiryLine)} fill="none" stroke="#f97316" strokeWidth="2.5" strokeLinejoin="round" />

        {/* 1-day P/L (blue) */}
        {daysLeft > 1 && (
          <path d={toPath(oneDayLine)} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" strokeDasharray="6,3" />
        )}

        {/* Today P/L (teal) */}
        {T_now > 0 && (
          <path d={toPath(todayLine)} fill="none" stroke="#0d9488" strokeWidth="2.5" strokeLinejoin="round" />
        )}

        {/* Dot at current price on today line */}
        {underlying && S_inRange && T_now > 0 && (
          <>
            <circle cx={xS(S_now)} cy={yS(todayPnlAtCurrent)} r="5" fill="#0d9488" stroke="white" strokeWidth="2" />
          </>
        )}

        {/* Axes */}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={PAD.t + ch} stroke="#cbd5e1" strokeWidth="1" />
        <line x1={PAD.l} y1={PAD.t + ch} x2={PAD.l + cw} y2={PAD.t + ch} stroke="#cbd5e1" strokeWidth="1" />

        {/* Axis labels */}
        <text x={PAD.l + cw / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="#64748b" fontStyle="italic">
          Underlying price
        </text>
        <text
          x={14} y={PAD.t + ch / 2} textAnchor="middle" fontSize="11" fill="#64748b"
          transform={`rotate(-90,14,${PAD.t + ch / 2})`}
        >
          P/L
        </text>

        {/* Legend */}
        <g transform={`translate(${PAD.l + cw - 310}, ${PAD.t + 8})`}>
          <rect x="0" y="0" width="300" height="22" fill="white" rx="3" stroke="#e2e8f0" />
          <line x1="8" y1="11" x2="26" y2="11" stroke="#f97316" strokeWidth="2.5" />
          <text x="30" y="15" fontSize="10" fill="#475569">Expiry P/L</text>
          {T_now > 0 && (
            <>
              <line x1="108" y1="11" x2="126" y2="11" stroke="#0d9488" strokeWidth="2.5" />
              <text x="130" y="15" fontSize="10" fill="#475569">Today P/L ({daysLeft}d)</text>
            </>
          )}
          {daysLeft > 1 && (
            <>
              <line x1="218" y1="11" x2="236" y2="11" stroke="#3b82f6" strokeWidth="2" strokeDasharray="5,3" />
              <text x="240" y="15" fontSize="10" fill="#475569">1-day P/L</text>
            </>
          )}
        </g>
      </svg>
    </div>
  );
}

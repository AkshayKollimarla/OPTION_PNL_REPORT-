"use client";

/**
 * The legs of the structure, one line each — and the editor for them.
 *
 * This is the other half of the chain above it: the chain is where a contract
 * is chosen, this is where what was chosen is adjusted. It carries the fields
 * that used to need a card apiece, which is the point: four cards of thirty
 * fields pushed everything else off the screen, and all but a handful of those
 * fields are the same on every leg of a structure anyway.
 *
 * Type and expiry stay read-only. Changing either means a different contract,
 * and that is a click in the chain rather than a typo correction here.
 */

const fmtMoney = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const Box = ({ wide, ...props }) => (
  <input
    {...props}
    type="number"
    step="any"
    className={`${wide ? "w-24" : "w-20"} rounded border border-slate-200 bg-white px-1.5 py-1 text-right text-xs tabular-nums text-slate-700 focus:border-blue-400 focus:outline-none`}
  />
);

const COLUMNS = ["Strike", "Type", "Expiration", "S/L", "Size", "Price", "Exit", "IV", "MM Loss", "P&L", ""];

export default function SelectedLegsStrip({ legs = [], onChange, onSide, onRemove }) {
  if (!legs.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-400">
        Click a bid or an ask in the chain to add a leg. The bid sells, the ask buys.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-100 bg-slate-50">
      <table className="w-full min-w-[820px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200">
            {COLUMNS.map((h, i) => (
              <th key={h || `blank${i}`}
                className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.key} className="border-b border-slate-100 last:border-0">
              <td className="px-2 py-1.5">
                <Box value={l.strike ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "strike", e.target.value)} />
              </td>
              <td className="px-2 py-1.5 text-slate-500">{l.optType === "CALL" ? "Call" : "Put"}</td>
              <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{l.expiry || "—"}</td>
              <td className="px-2 py-1.5">
                {/* One control, two states. A long and a short are the same leg
                    sized the other way, so this flips the sign of the quantity
                    rather than being a field of its own. */}
                <button type="button" onClick={() => onSide?.(l.key, l.side === "LONG" ? "SHORT" : "LONG")}
                  className={`rounded px-2 py-0.5 text-[11px] font-bold transition-colors ${
                    l.side === "LONG"
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-red-100 text-red-700 hover:bg-red-200"}`}>
                  {l.side === "LONG" ? "Long" : "Short"}
                </button>
              </td>
              <td className="px-2 py-1.5">
                <Box value={l.size ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "size", e.target.value)} />
              </td>
              <td className="px-2 py-1.5">
                <Box wide value={l.price ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "price", e.target.value)} />
              </td>
              <td className="px-2 py-1.5">
                <Box wide value={l.exit ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "exit", e.target.value)} />
              </td>
              {/* Live off the chain, not typed: it is the volatility of the
                  contract on the line, and it moves with the market. */}
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                {l.iv == null ? "—" : `${(l.iv * 100).toFixed(1)}%`}
              </td>
              <td className="px-2 py-1.5">
                <Box value={l.mm ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "mm", e.target.value)} />
              </td>
              <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${
                l.pnl == null ? "text-slate-400" : l.pnl < 0 ? "text-red-600" : "text-emerald-600"}`}>
                {fmtMoney(l.pnl)}
              </td>
              <td className="px-2 py-1.5 text-right">
                <button type="button" title="Remove this leg" onClick={() => onRemove?.(l.key)}
                  className="rounded px-1.5 py-0.5 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500">
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

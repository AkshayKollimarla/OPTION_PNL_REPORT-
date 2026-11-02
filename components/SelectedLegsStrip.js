"use client";

/**
 * The legs currently in the structure, one line each.
 *
 * This is the other half of the chain above it: the chain is where a contract
 * is chosen, this is where what was chosen is adjusted. Size and price are
 * editable because they are the two things a fill changes; strike, type and
 * expiry are not, because changing those means a different contract and that
 * is a click in the chain, not a typo correction here.
 */

const fmtPx = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
};

const fmtMoney = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const Box = (props) => (
  <input
    {...props}
    className="w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-right text-xs tabular-nums text-slate-700 focus:border-blue-400 focus:outline-none"
  />
);

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
      <table className="w-full min-w-[640px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-200">
            {["Strike", "Type", "Expiration", "S/L", "Size", "Price", "IV", "P&L", ""].map((h) => (
              <th key={h} className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.key} className="border-b border-slate-100 last:border-0">
              <td className="px-2 py-1.5 font-semibold tabular-nums text-slate-700">{l.strike || "—"}</td>
              <td className="px-2 py-1.5 text-slate-500">{l.optType === "CALL" ? "Call" : "Put"}</td>
              <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{l.expiry || "—"}</td>
              <td className="px-2 py-1.5">
                {/* One control, two states. A long and a short are the same
                    leg sized the other way, so this flips the sign of the
                    quantity rather than being a field of its own. */}
                <button type="button" onClick={() => onSide?.(l.key, l.side === "LONG" ? "SHORT" : "LONG")}
                  className={`rounded px-2 py-0.5 text-[11px] font-bold transition-colors ${
                    l.side === "LONG"
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-red-100 text-red-700 hover:bg-red-200"}`}>
                  {l.side === "LONG" ? "Long" : "Short"}
                </button>
              </td>
              <td className="w-20 px-2 py-1.5">
                <Box type="number" step="any" value={l.size ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "size", e.target.value)} />
              </td>
              <td className="w-24 px-2 py-1.5">
                <Box type="number" step="any" value={l.price ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "price", e.target.value)} />
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                {l.iv == null ? "—" : `${(l.iv * 100).toFixed(1)}%`}
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

export { fmtPx };

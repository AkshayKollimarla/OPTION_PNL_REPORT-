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
    className={`${wide ? "w-24" : "w-20"} rounded border border-slate-200 bg-white px-1.5 py-1 text-right text-[13px] tabular-nums text-slate-700 focus:border-blue-400 focus:outline-none`}
  />
);

/**
 * The strike, chosen from what is actually listed.
 *
 * A strike the leg already carries that the chain does not list is kept at the
 * top of the list and marked, so opening the picker on an older structure
 * cannot silently move it to a neighbouring strike.
 */
function StrikePicker({ value, choices, onPick }) {
  const current = value === "" || value === null || value === undefined ? null : Number(value);
  const listed = current !== null && choices.some((c) => Number(c) === current);
  return (
    <select
      value={current === null ? "" : String(current)}
      onChange={(e) => onPick(e.target.value)}
      className="w-24 rounded border border-slate-200 bg-white px-1.5 py-1 text-right text-[13px] font-semibold tabular-nums text-slate-700 focus:border-blue-400 focus:outline-none"
    >
      {current === null && <option value="">—</option>}
      {current !== null && !listed && (
        <option value={String(current)}>{current} (not listed)</option>
      )}
      {choices.map((c) => <option key={c} value={String(c)}>{c}</option>)}
    </select>
  );
}

const columnsFor = (lotSize) => [
  "Strike", "Type", "Expiration", "S/L",
  lotSize > 1 ? "Size (lots)" : "Size",
  "Price", "Exit", "IV", "MM Loss", "P&L", "",
];

/**
 * `lotSize` is how many of the underlying one unit of Size is worth -- 100 on
 * a US equity option, 1 on a Deribit coin option. Size is typed and shown in
 * lots, and the shares that makes is printed under the box: the book stores
 * shares and prices per share, so what is actually being recorded should not
 * have to be taken on trust.
 */
export default function SelectedLegsStrip({ legs = [], onChange, onSide, onRemove, onAdd, lotSize = 1 }) {
  const COLUMNS = columnsFor(lotSize);
  if (!legs.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center">
        <p className="text-[13px] text-slate-500">
          Click a bid or an ask in the chain to add a leg. The bid sells, the ask buys.
        </p>
        {onAdd && <AddLegButton onAdd={onAdd} className="mt-3" />}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-100 bg-slate-50">
      <table className="w-full min-w-[860px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-slate-200">
            {COLUMNS.map((h, i) => (
              <th key={h || `blank${i}`}
                className="px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-700">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.key} className="border-b border-slate-100 last:border-0">
              {/* Every strike listed for this expiry, up and down, rather
                  than a number to be known and typed. The box underneath is
                  kept for a leg the chain cannot offer strikes for -- another
                  expiry, or no chain loaded -- so nothing becomes unreachable
                  when the picker has nothing to show. */}
              <td className="px-2 py-1.5">
                {l.choices?.length ? (
                  <StrikePicker value={l.strike} choices={l.choices}
                    onPick={(v) => onChange?.(l.key, "strikePick", v)} />
                ) : (
                  <Box value={l.strike ?? ""} placeholder="—"
                    onChange={(e) => onChange?.(l.key, "strike", e.target.value)} />
                )}
              </td>
              <td className="px-2 py-1.5 font-medium text-slate-600">{l.optType === "CALL" ? "Call" : "Put"}</td>
              <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">{l.expiry || "—"}</td>
              <td className="px-2 py-1.5">
                {/* One control, two states. A long and a short are the same leg
                    sized the other way, so this flips the sign of the quantity
                    rather than being a field of its own. */}
                <button type="button" onClick={() => onSide?.(l.key, l.side === "LONG" ? "SHORT" : "LONG")}
                  className={`rounded px-2.5 py-1 text-xs font-bold transition-colors ${
                    l.side === "LONG"
                      ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                      : "bg-red-100 text-red-700 hover:bg-red-200"}`}>
                  {l.side === "LONG" ? "Long" : "Short"}
                </button>
              </td>
              <td className="px-2 py-1.5">
                <Box value={l.size ?? ""} placeholder="—"
                  title={lotSize > 1 ? `1 = ${lotSize} shares (one contract)` : undefined}
                  onChange={(e) => onChange?.(l.key, "size", e.target.value)} />
                {lotSize > 1 && Number(l.size) > 0 && (
                  <span className="mt-0.5 block text-right text-[10px] tabular-nums text-slate-500">
                    {(Number(l.size) * lotSize).toLocaleString()} sh
                  </span>
                )}
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
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                {l.iv == null ? "—" : `${(l.iv * 100).toFixed(1)}%`}
              </td>
              <td className="px-2 py-1.5">
                <Box value={l.mm ?? ""} placeholder="—"
                  onChange={(e) => onChange?.(l.key, "mm", e.target.value)} />
              </td>
              <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${
                l.pnl == null ? "text-slate-500" : l.pnl < 0 ? "text-red-600" : "text-emerald-600"}`}>
                {fmtMoney(l.pnl)}
              </td>
              <td className="px-2 py-1.5 text-right">
                <button type="button" title="Remove this leg" onClick={() => onRemove?.(l.key)}
                  className="rounded px-1.5 py-0.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600">
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onAdd && (
        <div className="border-t border-slate-100 px-2 py-2">
          <AddLegButton onAdd={onAdd} />
        </div>
      )}
    </div>
  );
}

function AddLegButton({ onAdd, className = "" }) {
  return (
    <button type="button" onClick={onAdd}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-dashed border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 transition-colors hover:border-teal-400 hover:bg-teal-50 ${className}`}>
      <span className="text-sm leading-none">+</span> Add Leg
    </button>
  );
}

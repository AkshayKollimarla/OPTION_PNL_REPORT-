"use client";

import { useEffect, useMemo, useState } from "react";
import { toCsv, downloadCsv } from "../../lib/csv";

/**
 * The monthly trade log, filled in by closing a strategy rather than by
 * typing it out again.
 */

const money = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

// Zero is written as a plain 0 rather than coloured or dashed: in a gain/loss
// column it means "nothing on this side", which is a fact, not a gap.
const Cell = ({ v, tone }) => {
  const n = Number(v) || 0;
  const colour = n === 0 ? "text-slate-400" : tone === "gain" ? "text-emerald-600"
    : tone === "loss" ? "text-red-600" : n < 0 ? "text-red-600" : "text-emerald-600";
  return <td className={`px-3 py-2 text-right tabular-nums font-semibold ${colour}`}>{money(n)}</td>;
};

const COLUMNS = [
  { key: "coin", label: "Coin" },
  { key: "day", label: "Date" },
  { key: "optionPnl", label: "Option PnL", tone: "signed" },
  { key: "futuresPnl", label: "Futures PnL", tone: "signed" },
  { key: "optionsLoss", label: "Options Loss", tone: "loss" },
  { key: "futuresGain", label: "Futures Gain", tone: "gain" },
  { key: "futuresLoss", label: "Futures Loss", tone: "loss" },
  { key: "optionsGain", label: "Options Gain", tone: "gain" },
  { key: "booked", label: "Net Booked", tone: "signed" },
];

export default function MonthlyPnlPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    fetch("/api/monthly-pnl", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setData(j)))
      .catch((e) => setErr(e.message));
  }, []);

  const months = data?.months || [];
  const grand = data?.grand;

  const csvFor = (m) => {
    const rows = [...m.lines.map((l) => ({ ...l, month: m.label })),
      { month: m.label, coin: "TOTAL", day: "", ...m.totals }];
    downloadCsv(`trade-log-${m.key}.csv`,
      toCsv(rows, [{ key: "month", label: "Month" }, ...COLUMNS]));
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Monthly PnL</h1>
          <p className="text-[13px] text-slate-500">
            Every structure that has been closed, logged under the month it closed in. Nothing here is
            typed twice — a strategy appears the moment it is marked closed with its figures.
          </p>
        </div>
        {grand?.count > 0 && (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-2 text-right">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">All months</p>
            <p className={`text-xl font-bold tabular-nums ${grand.booked < 0 ? "text-red-600" : "text-emerald-600"}`}>
              {money(grand.booked)}
            </p>
            <p className="text-[11px] text-slate-500">{grand.count} closed</p>
          </div>
        )}
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
      )}

      {!data && !err && <p className="text-sm text-slate-500 animate-pulse">Loading the closed book…</p>}

      {data && !months.length && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
          Nothing closed yet. Set a strategy&apos;s status to Closed in the simulator and it will appear here.
        </div>
      )}

      {months.map((m) => (
        <section key={m.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
              Options &amp; futures trade logs — {m.label}
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-slate-500">{m.totals.count} closed</span>
              <button type="button" onClick={() => csvFor(m)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                Download CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  {COLUMNS.map((c) => (
                    <th key={c.key}
                      className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-700 ${
                        c.key === "coin" || c.key === "day" ? "text-left" : "text-right"}`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.lines.map((l) => (
                  <tr key={l.key} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2 font-bold text-slate-800">
                      {l.coin}
                      {l.account && <span className="ml-2 text-[11px] font-normal text-slate-500">{l.account}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-600">{l.day}</td>
                    <Cell v={l.optionPnl} />
                    <Cell v={l.futuresPnl} />
                    <Cell v={l.optionsLoss} tone="loss" />
                    <Cell v={l.futuresGain} tone="gain" />
                    <Cell v={l.futuresLoss} tone="loss" />
                    <Cell v={l.optionsGain} tone="gain" />
                    <Cell v={l.booked} />
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                  <td className="px-3 py-2 text-slate-700">Total</td>
                  <td className="px-3 py-2" />
                  <Cell v={m.totals.optionPnl} />
                  <Cell v={m.totals.futuresPnl} />
                  <Cell v={m.totals.optionsLoss} tone="loss" />
                  <Cell v={m.totals.futuresGain} tone="gain" />
                  <Cell v={m.totals.futuresLoss} tone="loss" />
                  <Cell v={m.totals.optionsGain} tone="gain" />
                  <Cell v={m.totals.booked} />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {/* A structure closed without an end date has no month to sit under.
          Shown rather than dropped, so the log cannot quietly lose a trade. */}
      {data?.undated?.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50">
          <div className="border-b border-amber-200 px-4 py-2.5">
            <h2 className="text-sm font-bold text-amber-800">Closed with no end date</h2>
            <p className="text-[11px] text-amber-700">
              These are closed but carry no end date, so there is no month to file them under. Set an end
              date on each and it will drop into place.
            </p>
          </div>
          <ul className="divide-y divide-amber-200">
            {data.undated.map((l) => (
              <li key={l.key} className="flex items-center justify-between px-4 py-2 text-[13px]">
                <span className="font-bold text-amber-900">{l.coin}</span>
                <span className="tabular-nums text-amber-800">
                  option {money(l.optionPnl)} · futures {money(l.futuresPnl)} · booked {money(l.booked)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { toCsv, downloadCsv } from "../../lib/csv";
import { buildMonths } from "../../lib/monthly-pnl";

/**
 * The monthly trade log, filled in by closing a strategy rather than by
 * typing it out again.
 */

// A sentinel for the trades that carry no account. Spelt out rather than a
// control character: a NUL in the source makes git treat the whole file as
// binary and stop showing diffs for it.
const NO_ACCOUNT = "__no_account__";
const accountLabel = (a) => (a === NO_ACCOUNT ? "No account" : a);

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
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [account, setAccount] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Which date files a structure. Entry by default: it is the date the
  // position is known by -- the strategies are named for it, HOOD-29THJUNE --
  // and every closed structure has one, where three have no end date at all.
  const [basis, setBasis] = useState("entered");

  useEffect(() => {
    fetch("/api/monthly-pnl", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.error ? setErr(j.error) : setRows(j.rows || [])))
      .catch((e) => setErr(e.message));
  }, []);

  // Taken from the closed book itself rather than the accounts table, so the
  // list only offers accounts that actually have something closed under them.
  //
  // Structures with no account get an entry of their own. Thirty of them are
  // in this book -- entries from before trades carried an account at all --
  // and without somewhere to put them they would be reachable only under
  // "all", so going through the accounts one by one would silently miss a
  // quarter of the closed trades.
  const accounts = useMemo(() => {
    const seen = new Set();
    let none = false;
    for (const r of rows || []) { if (r.account) seen.add(r.account); else none = true; }
    return { named: [...seen].sort(), none };
  }, [rows]);

  // Narrowing regroups and re-totals through the same function the whole page
  // is built on, so a month's total for one account is arrived at the same way
  // as the total for all of them.
  const { months, undated, grand } = useMemo(() => {
    const all = rows || [];
    const byAccount = account === "all" ? all
      : account === NO_ACCOUNT ? all.filter((r) => !r.account)
      : all.filter((r) => r.account === account);
    // Both ends are inclusive, and compared as YYYY-MM-DD strings: the dates
    // sort that way already, so there is no Date to build and no timezone to
    // shift the boundary by a day.
    //
    // A structure with no end date cannot be shown to fall inside a range, so
    // a range excludes it rather than keeping it on the grounds that nothing
    // ruled it out. The page says so where they are listed.
    // The range filters on the SAME date the page is filed by, so the dates
    // on screen always sit inside the range that produced them.
    const picked = (!from && !to) ? byAccount : byAccount.filter((r) => {
      const d = String(r[basis] || "");
      if (!d) return false;
      return (!from || d >= from) && (!to || d <= to);
    });
    return buildMonths(picked, basis);
  }, [rows, account, from, to, basis]);

  const ranged = Boolean(from || to);

  const data = rows ? { months, undated, grand } : null;

  const csvFor = (m) => {
    const rows = [...m.lines.map((l) => ({ ...l, month: m.label })),
      { month: m.label, coin: "TOTAL", day: "", ...m.totals }];
    const slug = [
      account === "all" ? null : accountLabel(account).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      basis === "ended" ? "by-close" : "by-entry",
      ranged ? `${from || "start"}_${to || "end"}` : null,
    ].filter(Boolean).join("-");
    // The export carries BOTH dates whichever way the page is filed, so a
    // spreadsheet built from it can be re-cut without coming back here.
    downloadCsv(`trade-log-${m.key}${slug ? "-" + slug : ""}.csv`,
      toCsv(rows, [
        { key: "month", label: "Month" },
        ...COLUMNS,
        { key: "entered", label: "Entry date" },
        { key: "ended", label: "Close date" },
      ]));
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Monthly PnL</h1>
          <p className="text-[13px] text-slate-500">
            Every structure that has been closed, filed under the month it was{" "}
            {basis === "ended" ? "closed in" : "entered in"}. Nothing here is typed twice — a strategy
            appears the moment it is marked closed with its figures.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600">{basis === "ended" ? "Closed from" : "Entered from"}</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-700" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600">to</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-700" />
          </label>
          {(ranged || account !== "all") && (
            <button type="button"
              onClick={() => { setFrom(""); setTo(""); setAccount("all"); }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              Clear filters
            </button>
          )}
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600">File by</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] font-semibold text-slate-700">
              <option value="entered">Entry date</option>
              <option value="ended">Close date</option>
            </select>
          </label>
          {(accounts.named.length + (accounts.none ? 1 : 0)) > 1 && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-600">Account</span>
              <select value={account} onChange={(e) => setAccount(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] font-semibold text-slate-700">
                <option value="all">All accounts</option>
                {accounts.named.map((a) => <option key={a} value={a}>{a}</option>)}
                {accounts.none && <option value={NO_ACCOUNT}>No account</option>}
              </select>
            </label>
          )}
          {grand?.count > 0 && (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-2 text-right">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">All months</p>
            <p className={`text-xl font-bold tabular-nums ${grand.booked < 0 ? "text-red-600" : "text-emerald-600"}`}>
              {money(grand.booked)}
            </p>
            <p className="text-[11px] text-slate-500">
              {grand.count} closed{account === "all" ? "" : ` · ${accountLabel(account)}`}
            </p>
          </div>
          )}
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
      )}

      {!rows && !err && <p className="text-sm text-slate-500 animate-pulse">Loading the closed book…</p>}

      {data && !months.length && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
          {!ranged && account === "all"
            ? "Nothing closed yet. Set a strategy’s status to Closed in the simulator and it will appear here."
            : `Nothing closed${account === "all" ? "" : ` under ${accountLabel(account)}`}${
                ranged
                  ? ` ${basis === "ended" ? "closed" : "entered"} between ${from || "the start"} and ${to || "today"}`
                  : ""}.`}
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
                    {/* The basis date leads; the other is kept underneath so
                        switching the basis never hides a date that was there. */}
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-600">
                      {l.day || "—"}
                      <span className="block text-[11px] font-normal text-slate-400">
                        {basis === "ended"
                          ? (l.enteredDay ? `in ${l.enteredDay}` : "")
                          : (l.endedDay ? `out ${l.endedDay}` : "no end date")}
                      </span>
                    </td>
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
            <h2 className="text-sm font-bold text-amber-800">
              Closed with no {basis === "ended" ? "end" : "entry"} date
            </h2>
            <p className="text-[11px] text-amber-700">
              These are closed but carry no {basis === "ended" ? "end" : "entry"} date, so there is no month
              to file them under. Set one on each and it will drop into place.
              {ranged && " A date range leaves them out, since there is no date to place them inside it."}
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

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toCsv, downloadCsv } from "../../lib/csv";
import { groupByDate, tierLabel, TIER_ORDER } from "../../lib/results-calendar";

/**
 * Results: what is about to be announced.
 *
 * Earnings for every US stock in the window, and the Fed and data calendar
 * beside them. It loads itself and keeps itself current -- the point of the
 * page is to be glanced at, not operated.
 *
 * The High / Medium / Low badges are published ratings, not this page's
 * opinion: economic events carry the calendar feed's rating and Fed releases
 * carry a level mapped from the Fed's own release category. Where a source
 * rates nothing, the row says so.
 */

// Slow-moving data from four free public endpoints. Five minutes keeps the
// page honest without making a poller out of it; the server caches underneath
// this anyway, so a refresh usually costs nothing.
const REFRESH_MS = 5 * 60 * 1000;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const money = (v, places = 2) => {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
};

// $255.1B. A market cap to the dollar is nine digits of noise when the only
// question is how big the name is.
function compactCap(v) {
  const n = num(v);
  if (n === null || !Number.isFinite(n) || n <= 0) return "—";
  for (const [size, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n >= size) return `$${(n / size).toFixed(n / size >= 100 ? 0 : 1)}${suffix}`;
  }
  return `$${n.toFixed(0)}`;
}

const IMPACT_STYLE = {
  High: "bg-red-50 text-red-700 border-red-200",
  Medium: "bg-amber-50 text-amber-700 border-amber-200",
  Low: "bg-slate-100 text-slate-600 border-slate-200",
  Holiday: "bg-blue-50 text-blue-700 border-blue-200",
};

function Impact({ value }) {
  // An unrated row is shown as unrated. Giving it a level to keep the column
  // tidy would make a guess look exactly like a published rating.
  if (!value) {
    return (
      <span className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
        Unrated
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
      IMPACT_STYLE[value] || IMPACT_STYLE.Low}`}>
      {value}
    </span>
  );
}

const WHEN_STYLE = {
  bmo: "bg-amber-50 text-amber-700 border-amber-200",
  amc: "bg-indigo-50 text-indigo-700 border-indigo-200",
  tbd: "bg-slate-100 text-slate-600 border-slate-200",
};
const WHEN_SHORT = { bmo: "Before open", amc: "After close", tbd: "Time TBD" };

/* A refresh that failed over data that is still good. The old answer stays on
   the page -- blanking a section that was right four minutes ago because a
   free endpoint rate-limited is the worse outcome -- and this says how old it
   now is, so nothing is presented as current that is not. */
const Stale = ({ on, at }) =>
  on ? (
    <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
      refresh failed{at ? ` · as at ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
    </span>
  ) : null;

const Chip = ({ active, onClick, children, title }) => (
  <button type="button" onClick={onClick} title={title}
    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors ${
      active
        ? "border-brand bg-brand text-white"
        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"}`}>
    {children}
  </button>
);

const inputCls = "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-700";
const labelCls = "mb-1 block text-[11px] font-semibold text-slate-600";
const cardCls = "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card";
const headCls = "flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5";

// How many of a day's reports are drawn before the rest are put behind a
// click. An early-November Thursday carries six hundred of them, and every one
// in the DOM at once makes the page crawl for no one's benefit -- the biggest
// names come first, and the day heading always states the true count.
const PER_DAY = 25;

export default function ResultsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);

  // Earnings filters
  const [q, setQ] = useState("");
  const [minTier, setMinTier] = useState("all");
  const [when, setWhen] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

  // Calendar filters
  const [impacts, setImpacts] = useState(() => new Set(["High", "Medium", "Low"]));
  const [fedOnly, setFedOnly] = useState(false);

  const load = useCallback((d) => {
    fetch(`/api/results?days=${d}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) throw new Error(j.error);
        setData(j);
        setErr(null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { setLoading(true); load(days); }, [load, days]);
  useEffect(() => {
    const t = setInterval(() => load(days), REFRESH_MS);
    return () => clearInterval(t);
  }, [load, days]);

  const held = useMemo(() => new Set(data?.held || []), [data]);

  // Times are formatted in New York, because that is where these events are
  // scheduled, and again in the reader's own zone, because that is the clock
  // they are sitting at. Built once rather than per row.
  const fmt = useMemo(() => {
    const et = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    // A short zone name the reader recognises ("IST") rather than the full
    // "Asia/Calcutta".
    const zoneName = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" })
      .formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || localZone;
    return { et, local, zoneName, localZone };
  }, []);

  const sameZone = fmt.localZone === "America/New_York";

  const earnings = useMemo(() => {
    const rows = data?.earnings?.rows || [];
    const needle = q.trim().toUpperCase();
    const floor = minTier === "all" ? Infinity : TIER_ORDER.indexOf(minTier);
    const picked = rows.filter((r) => {
      if (mineOnly && !held.has(r.symbol)) return false;
      if (when !== "all" && r.when !== when) return false;
      if (floor !== Infinity) {
        // Tiers run largest first, so "this size and above" is an index at or
        // below the chosen one. A row with no market cap has no size to
        // compare and is excluded rather than assumed small.
        const idx = r.tier ? TIER_ORDER.indexOf(r.tier) : Infinity;
        if (idx > floor) return false;
      }
      if (needle && !r.symbol.includes(needle) && !r.name.toUpperCase().includes(needle)) return false;
      return true;
    });
    // Biggest first within a day: on a six-hundred-row Thursday the order is
    // the only thing making the page useful.
    const groups = groupByDate(picked).map((g) => ({
      ...g,
      rows: [...g.rows].sort((a, b) =>
        (b.marketCap || 0) - (a.marketCap || 0) || a.symbol.localeCompare(b.symbol)),
      mine: g.rows.filter((r) => held.has(r.symbol)).length,
    }));
    return { groups, total: picked.length, all: rows.length };
  }, [data, q, minTier, when, mineOnly, held]);

  // The feed publishes the whole of the current week, Monday included, so by
  // Thursday most of it has already happened. This page is about what is
  // coming, and a release whose number is already out is not that -- it is
  // dropped rather than listed under a date the reader has to check.
  const eventsAhead = useMemo(
    () => (data?.events?.rows || []).filter((e) => !data?.marketDate || e.date >= data.marketDate),
    [data]
  );

  const events = useMemo(() => {
    const rows = eventsAhead.filter((e) => {
      if (fedOnly && !e.fed) return false;
      // An unrated row survives every impact filter: hiding it under a rating
      // it does not have would be a lie either way.
      if (e.impact && !impacts.has(e.impact)) return false;
      return true;
    });
    return groupByDate(rows);
  }, [eventsAhead, impacts, fedOnly]);

  const fomc = data?.fomc?.rows || [];
  const nextFomc = fomc[0] || null;
  const news = data?.news?.rows || [];

  const highAhead = eventsAhead.filter((e) => e.impact === "High").length;
  const mineCount = (data?.earnings?.rows || []).filter((r) => held.has(r.symbol)).length;
  const nextMine = (data?.earnings?.rows || [])
    .filter((r) => held.has(r.symbol))
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;

  // Built from the previous state rather than from the value captured when
  // this render ran. Two chips clicked inside one React batch both read the
  // same captured Set, so the second toggle silently undid the first.
  const toggle = (value, apply) => {
    apply((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const daysUntil = (isoDate) => {
    const from = data?.marketDate;
    if (!from || !isoDate) return null;
    return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  };

  const untilLabel = (isoDate) => {
    const d = daysUntil(isoDate);
    if (d === null) return "";
    // Dated by the US market, so "today" has to mean the New York day. A past
    // date says so: this read "today" for both Monday and Tuesday when a
    // negative count fell through to the same branch.
    if (d === 0) return "today";
    if (d === 1) return "tomorrow";
    if (d === -1) return "yesterday";
    return d > 0 ? `in ${d} days` : `${-d} days ago`;
  };

  function downloadEarnings() {
    const rows = earnings.groups.flatMap((g) => g.rows.map((r) => ({
      date: r.date, symbol: r.symbol, name: r.name, when: WHEN_SHORT[r.when],
      eps: r.eps, lastEps: r.lastEps, marketCap: r.marketCap,
      size: r.tier ? tierLabel(r.tier) : "", estimates: r.estimates,
      quarter: r.quarter, inBook: held.has(r.symbol) ? "yes" : "",
    })));
    downloadCsv(`earnings-next-${days}-days.csv`, toCsv(rows, [
      { key: "date", label: "Date" }, { key: "symbol", label: "Symbol" },
      { key: "name", label: "Company" }, { key: "when", label: "When" },
      { key: "eps", label: "EPS forecast" }, { key: "lastEps", label: "Last year EPS" },
      { key: "marketCap", label: "Market cap" }, { key: "size", label: "Size" },
      { key: "estimates", label: "# estimates" }, { key: "quarter", label: "Quarter" },
      { key: "inBook", label: "In book" },
    ]));
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Results</h1>
          <p className="text-[13px] text-slate-500">
            Upcoming US earnings, and the Fed and data calendar beside them. Loads itself and refreshes
            every five minutes — times are New York{sameZone ? "" : `, with your own ${fmt.zoneName} beneath`}.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={labelCls}>Window</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
              <option value={7}>Next 7 days</option>
              <option value={14}>Next 14 days</option>
              <option value={30}>Next 30 days</option>
            </select>
          </label>
          {data?.asOf && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-right">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">As of</p>
              <p className="text-[13px] font-semibold tabular-nums text-slate-700">
                {new Date(data.asOf).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          )}
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
      )}

      {loading && !data && <p className="text-sm text-slate-500 animate-pulse">Loading the calendar…</p>}

      {data && (
        <>
          {/* What is coming, before any of the lists. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className={`${cardCls} px-4 py-3`}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Next FOMC decision</p>
              {nextFomc ? (
                <>
                  <p className="text-lg font-bold text-slate-800">
                    {nextFomc.date} <span className="text-[13px] font-semibold text-slate-500">{untilLabel(nextFomc.date)}</span>
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {nextFomc.projections ? "Projections and press conference" : "Statement only"}
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-slate-500">{data.fomc?.error ? "Schedule unavailable" : "None scheduled"}</p>
              )}
            </div>
            <div className={`${cardCls} px-4 py-3`}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">High impact still ahead</p>
              <p className="text-lg font-bold text-slate-800">{highAhead}</p>
              <p className="text-[11px] text-slate-500">US events rated High, today onwards</p>
            </div>
            <div className={`${cardCls} px-4 py-3`}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Reporting in your book</p>
              <p className="text-lg font-bold text-slate-800">{mineCount}</p>
              <p className="text-[11px] text-slate-500">
                {nextMine
                  ? `Next: ${nextMine.symbol} on ${nextMine.date} (${WHEN_SHORT[nextMine.when].toLowerCase()})`
                  : held.size
                    ? "Nothing you hold reports in this window"
                    : "No open strategies to match"}
              </p>
            </div>
          </div>

          {/* ───────────────────────── earnings ───────────────────────── */}
          <section className={cardCls}>
            <div className={headCls}>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                US earnings — next {days} days
              </h2>
              <div className="flex items-center gap-3">
                <Stale on={data.earnings?.stale} at={data.earnings?.fetchedAt} />
                <span className="text-[11px] text-slate-500">
                  {earnings.total === earnings.all
                    ? `${earnings.total} reports`
                    : `${earnings.total} of ${earnings.all} reports`}
                </span>
                {earnings.total > 0 && (
                  <button type="button" onClick={downloadEarnings}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                    Download CSV
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-4 py-3">
              <label className="block">
                <span className={labelCls}>Search</span>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol or company"
                  className={`${inputCls} w-48`} />
              </label>
              <label className="block">
                <span className={labelCls}>Size</span>
                <select value={minTier} onChange={(e) => setMinTier(e.target.value)} className={inputCls}>
                  <option value="all">All sizes</option>
                  <option value="mega">Mega only ($200B+)</option>
                  <option value="large">Large and above ($10B+)</option>
                  <option value="mid">Mid and above ($2B+)</option>
                  <option value="small">Small and above ($300M+)</option>
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>When</span>
                <select value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls}>
                  <option value="all">Any time</option>
                  <option value="bmo">Before open</option>
                  <option value="amc">After close</option>
                  <option value="tbd">Time not given</option>
                </select>
              </label>
              <div className="flex items-end gap-2 pb-0.5">
                <Chip active={mineOnly} onClick={() => setMineOnly((v) => !v)}
                  title="Only symbols with an open strategy in the book">
                  In my book
                </Chip>
                {(q || minTier !== "all" || when !== "all" || mineOnly) && (
                  <button type="button"
                    onClick={() => { setQ(""); setMinTier("all"); setWhen("all"); setMineOnly(false); }}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                    Clear
                  </button>
                )}
              </div>
            </div>

            {data.earnings?.error && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[13px] text-red-700">
                The earnings calendar could not be read: {data.earnings.error}
              </div>
            )}
            {/* A day that failed to load and a day with nothing scheduled look
                identical once drawn, and only one of them means there is
                nothing to watch for. */}
            {data.earnings?.failedDates?.length > 0 && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[13px] text-amber-800">
                {data.earnings.failedDates.length > 4
                  ? `${data.earnings.failedDates.length} dates in this window did not load, so they are missing rather than empty.`
                  : `${data.earnings.failedDates.join(", ")} did not load, so ${
                      data.earnings.failedDates.length > 1 ? "those dates are" : "that date is"
                    } missing rather than empty.`}
              </div>
            )}

            {!earnings.groups.length ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                {earnings.all ? "Nothing matches these filters." : "No reports scheduled in this window."}
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {earnings.groups.map((g) => {
                  const open = expanded.has(g.date);
                  const shown = open ? g.rows : g.rows.slice(0, PER_DAY);
                  return (
                    <div key={g.date}>
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50/60 px-4 py-2">
                        <h3 className="text-[13px] font-bold uppercase tracking-wide text-slate-700">
                          {g.label} <span className="font-semibold text-slate-500">· {untilLabel(g.date)}</span>
                        </h3>
                        <span className="text-[11px] text-slate-500">
                          {g.rows.length} {g.rows.length === 1 ? "report" : "reports"}
                          {g.mine > 0 && <span className="ml-2 font-semibold text-indigo-600">{g.mine} in your book</span>}
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] border-collapse text-[13px]">
                          <thead>
                            <tr className="border-b border-slate-200">
                              <th className="px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-700">Symbol</th>
                              <th className="px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-700">Company</th>
                              <th className="px-3 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-700">When</th>
                              <th className="px-3 py-1.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-700">EPS fc</th>
                              <th className="px-3 py-1.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-700">Last yr</th>
                              <th className="px-3 py-1.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-700">Mkt cap</th>
                              <th className="px-3 py-1.5 text-right text-[11px] font-bold uppercase tracking-wide text-slate-700">Quarter</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((r) => {
                              const mine = held.has(r.symbol);
                              return (
                                <tr key={r.key} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${
                                  mine ? "bg-indigo-50/50" : ""}`}>
                                  <td className="px-3 py-1.5 font-bold text-slate-800">
                                    {r.symbol}
                                    {mine && (
                                      <span className="ml-2 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-indigo-700">
                                        held
                                      </span>
                                    )}
                                  </td>
                                  <td className="max-w-[260px] truncate px-3 py-1.5 text-slate-600" title={r.name}>{r.name}</td>
                                  <td className="px-3 py-1.5">
                                    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${WHEN_STYLE[r.when]}`}>
                                      {WHEN_SHORT[r.when]}
                                    </span>
                                  </td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${
                                    r.eps === null ? "text-slate-400" : r.eps < 0 ? "text-red-600" : "text-slate-700"}`}>
                                    {r.eps === null ? "—" : money(r.eps)}
                                  </td>
                                  <td className={`px-3 py-1.5 text-right tabular-nums ${
                                    r.lastEps === null ? "text-slate-400" : r.lastEps < 0 ? "text-red-600" : "text-slate-600"}`}>
                                    {r.lastEps === null ? "—" : money(r.lastEps)}
                                  </td>
                                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{compactCap(r.marketCap)}</td>
                                  <td className="px-3 py-1.5 text-right text-slate-500">{r.quarter || "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {g.rows.length > PER_DAY && (
                        <div className="px-4 py-2">
                          <button type="button"
                            onClick={() => toggle(g.date, setExpanded)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100">
                            {open
                              ? `Show the largest ${PER_DAY} only`
                              : `Show all ${g.rows.length} — largest ${PER_DAY} shown`}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ──────────────────── fed and data calendar ──────────────────── */}
          <section className={cardCls}>
            <div className={headCls}>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">Fed &amp; economic events — rest of this week</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Stale on={data.events?.stale} at={data.events?.fetchedAt} />
                {["High", "Medium", "Low"].map((lvl) => (
                  <Chip key={lvl} active={impacts.has(lvl)} onClick={() => toggle(lvl, setImpacts)}>
                    {lvl}
                  </Chip>
                ))}
                <Chip active={fedOnly} onClick={() => setFedOnly((v) => !v)} title="FOMC, Fed speakers and monetary policy only">
                  Fed only
                </Chip>
              </div>
            </div>

            <p className="border-b border-slate-200 px-4 py-2 text-[11px] text-slate-500">
              High, Medium and Low are the calendar&rsquo;s own published ratings — this page does not assign them.
              Only the current week is published, which is why the FOMC meeting dates below come from the Federal
              Reserve&rsquo;s own schedule instead.
            </p>

            {data.events?.error && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-[13px] text-red-700">
                The economic calendar could not be read: {data.events.error}
              </div>
            )}

            {!events.length ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                {eventsAhead.length
                  ? "Nothing matches these filters."
                  : data.events?.rows?.length
                    ? "Every US event published for this week has already happened."
                    : "No US events published for this week."}
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {events.map((g) => (
                  <div key={g.date}>
                    <div className="flex items-center justify-between bg-slate-50/60 px-4 py-2">
                      <h3 className="text-[13px] font-bold uppercase tracking-wide text-slate-700">
                        {g.label} <span className="font-semibold text-slate-500">· {untilLabel(g.date)}</span>
                      </h3>
                      <span className="text-[11px] text-slate-500">{g.rows.length} {g.rows.length === 1 ? "event" : "events"}</span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {g.rows.map((e) => (
                        <li key={e.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-slate-50">
                          <span className="w-20 shrink-0 tabular-nums text-[13px] font-semibold text-slate-700">
                            {fmt.et.format(new Date(e.at))}
                            {!sameZone && (
                              <span className="block text-[11px] font-normal text-slate-500">
                                {fmt.local.format(new Date(e.at))} {fmt.zoneName}
                              </span>
                            )}
                          </span>
                          <span className="w-20 shrink-0"><Impact value={e.impact} /></span>
                          <span className="min-w-[200px] flex-1 text-[13px] font-semibold text-slate-800">
                            {e.title}
                            {e.fed && (
                              <span className="ml-2 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-indigo-700">
                                Fed
                              </span>
                            )}
                          </span>
                          <span className="text-[12px] tabular-nums text-slate-500">
                            {e.forecast && <span className="mr-3">forecast <strong className="font-semibold text-slate-700">{e.forecast}</strong></span>}
                            {e.previous && <span>previous <strong className="font-semibold text-slate-700">{e.previous}</strong></span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ───────────────────── fomc meeting schedule ───────────────────── */}
          <section className={cardCls}>
            <div className={headCls}>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">FOMC meetings ahead</h2>
              <span className="flex items-center gap-2 text-[11px] text-slate-500">
                <Stale on={data.fomc?.stale} at={data.fomc?.fetchedAt} />
                From the Federal Reserve&rsquo;s published schedule
              </span>
            </div>
            {data.fomc?.error ? (
              <div className="px-4 py-3 text-[13px] text-red-700">The FOMC schedule could not be read: {data.fomc.error}</div>
            ) : !fomc.length ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">No meetings published.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {fomc.slice(0, 8).map((m) => (
                  <li key={m.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-slate-50">
                    <span className="w-28 shrink-0 tabular-nums text-[13px] font-bold text-slate-800">{m.date}</span>
                    <span className="w-20 shrink-0"><Impact value={m.impact} /></span>
                    <span className="flex-1 text-[13px] text-slate-700">
                      {m.title}
                      <span className="ml-2 text-[11px] text-slate-500">meets {m.starts} &ndash; {m.date}</span>
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500">{untilLabel(m.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ──────────────────────── fed press feed ──────────────────────── */}
          <section className={cardCls}>
            <div className={headCls}>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">Latest from the Fed</h2>
              <span className="flex items-center gap-2 text-[11px] text-slate-500">
                <Stale on={data.news?.stale} at={data.news?.fetchedAt} />
                Rated by the Fed&rsquo;s own release category
              </span>
            </div>
            {data.news?.error ? (
              <div className="px-4 py-3 text-[13px] text-red-700">The Fed feed could not be read: {data.news.error}</div>
            ) : !news.length ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">Nothing published.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {news.slice(0, 12).map((n) => (
                  <li key={n.key} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2 hover:bg-slate-50">
                    <span className="w-24 shrink-0 tabular-nums text-[12px] font-semibold text-slate-600">
                      {n.at ? n.at.slice(0, 10) : "—"}
                    </span>
                    <span className="w-20 shrink-0"><Impact value={n.impact} /></span>
                    <span className="min-w-[240px] flex-1">
                      <a href={n.link} target="_blank" rel="noopener noreferrer"
                        className="text-[13px] font-semibold text-slate-800 hover:text-brand">
                        {n.title}
                      </a>
                      {n.category && <span className="block text-[11px] text-slate-500">{n.category}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// The month-by-month trade log: one line per closed structure, the way it was
// being kept by hand in a spreadsheet.
//
// Nothing here is entered twice. A structure is logged because it was closed,
// with the figures recorded when it was closed, so the log is a view of the
// book rather than a second copy of it that can drift out of step with it.

const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Money, to the cent, after any arithmetic.
const money = (v) => Math.round(v * 100) / 100;

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

/**
 * The day, as the spreadsheet wrote it: 23RD OCT.
 *
 * Parsed from the parts rather than through a Date, which would read a plain
 * YYYY-MM-DD as midnight UTC and show the day before to anyone east of it.
 */
export function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const day = Number(m[3]);
  const mon = MONTHS[Number(m[2]) - 1];
  if (!mon) return "";
  // 1ST, 2ND, 3RD, 4TH ... and 11TH-13TH, which break the pattern.
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "TH"
    : day % 10 === 1 ? "ST" : day % 10 === 2 ? "ND" : day % 10 === 3 ? "RD" : "TH";
  return `${day}${suffix} ${mon.slice(0, 3)}`;
}

export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
  if (!m) return String(key || "");
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * One closed structure as a log line.
 *
 * The gain and loss columns are the same two figures split by sign, which is
 * how the sheet was kept -- a loss stays negative in its own column rather
 * than being written as a positive number under a heading that says LOSS,
 * because then a column of them cannot be summed into a total that means
 * anything.
 */
export function logLine(row) {
  const opt = money(num(row.opt_pnl));
  const fut = money(num(row.fut_pnl));
  return {
    key: row.key,
    coin: row.token || "",
    account: row.account || null,
    ended: row.ended || null,
    day: dayLabel(row.ended),
    legs: Number(row.legs) || 0,
    optionPnl: opt,
    futuresPnl: fut,
    optionsLoss: opt < 0 ? opt : 0,
    futuresGain: fut > 0 ? fut : 0,
    futuresLoss: fut < 0 ? fut : 0,
    optionsGain: opt > 0 ? opt : 0,
    // What the structure actually finished on. Recorded at close rather than
    // added up here: a booked figure that was written down is the one that
    // should be reported, even where it differs from the two halves.
    booked: money(num(row.net_booked_pnl)),
  };
}

export function totalsOf(lines) {
  const sum = (f) => money(lines.reduce((t, l) => t + l[f], 0));
  return {
    optionPnl: sum("optionPnl"),
    futuresPnl: sum("futuresPnl"),
    optionsLoss: sum("optionsLoss"),
    futuresGain: sum("futuresGain"),
    futuresLoss: sum("futuresLoss"),
    optionsGain: sum("optionsGain"),
    booked: sum("booked"),
    count: lines.length,
  };
}

/**
 * Closed structures grouped into months, newest month first and newest close
 * first inside each.
 *
 * A structure closed with no end date has no month to file it under, so it is
 * handed back separately rather than being guessed into one.
 */
export function buildMonths(rows) {
  const byMonth = new Map();
  const undated = [];

  for (const r of rows || []) {
    const line = logLine(r);
    const m = /^(\d{4}-\d{2})/.exec(String(r.ended || ""));
    if (!m) { undated.push(line); continue; }
    if (!byMonth.has(m[1])) byMonth.set(m[1], []);
    byMonth.get(m[1]).push(line);
  }

  const months = [...byMonth.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, lines]) => {
      lines.sort((a, b) => String(b.ended).localeCompare(String(a.ended)) || a.coin.localeCompare(b.coin));
      return { key, label: monthLabel(key), lines, totals: totalsOf(lines) };
    });

  return { months, undated, grand: totalsOf(months.flatMap((m) => m.lines)) };
}

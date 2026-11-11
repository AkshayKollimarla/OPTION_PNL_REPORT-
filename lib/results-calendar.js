// The calendar behind the Results page: when US companies report, and when the
// Fed and the big data releases land.
//
// Two different things get called "impact" here, and they are not the same, so
// they are kept apart and each is labelled with where it came from:
//
//   economic events  carry a High / Medium / Low rating published by the
//                    calendar feed itself.
//   Fed releases     carry the Federal Reserve's OWN release category
//                    ("Monetary Policy", "Enforcement Actions"), mapped to a
//                    level by the table below.
//
// Nothing here reads a headline and decides how important it looks. Where a
// source has no rating to give, the row carries null and the page shows it as
// unrated -- a badge invented from a title would sit on the page looking
// exactly like one a market actually published, which is the worst of both.

export const IMPACTS = ["High", "Medium", "Low"];

/**
 * A money or count field as the calendars write them.
 *
 * Accounting parentheses are a minus sign: ($0.23) is a loss of 23 cents, and
 * reading it as +0.23 would turn every loss-making quarter into a profitable
 * one. "N/A" and "" are absent rather than zero -- a consensus nobody has
 * published is not a forecast of break-even.
 */
export function parseAmount(raw) {
  const s = String(raw ?? "").trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s);
  const digits = s.replace(/[()$,%\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

// When in the session a company reports. It decides which session a position
// is exposed through, so "not supplied" stays its own answer rather than being
// quietly defaulted to one of the two.
const WHEN = {
  "time-pre-market": { code: "bmo", label: "Before open" },
  "time-after-hours": { code: "amc", label: "After close" },
};

export function whenOf(time) {
  return WHEN[String(time || "").trim()] || { code: "tbd", label: "Time not given" };
}

// Size bands, by the usual thresholds. A band is a restatement of the market
// cap, not a judgement about the stock: it exists so a week with six hundred
// reports in it can be cut down to the names that move an index.
const TIERS = [
  { tier: "mega", label: "Mega", min: 200e9 },
  { tier: "large", label: "Large", min: 10e9 },
  { tier: "mid", label: "Mid", min: 2e9 },
  { tier: "small", label: "Small", min: 300e6 },
  { tier: "micro", label: "Micro", min: 0 },
];

export function capTier(marketCap) {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return null;
  return (TIERS.find((t) => marketCap >= t.min) || TIERS[TIERS.length - 1]).tier;
}

export const tierLabel = (t) => TIERS.find((x) => x.tier === t)?.label || "Unknown";

export const TIER_ORDER = TIERS.map((t) => t.tier);

/**
 * One earnings row, as the page wants it.
 */
export function earningsRow(raw, date) {
  const symbol = String(raw?.symbol || "").trim().toUpperCase();
  if (!symbol) return null;
  const when = whenOf(raw.time);
  const marketCap = parseAmount(raw.marketCap);
  return {
    key: `${date}|${symbol}`,
    date,
    symbol,
    name: String(raw.name || "").trim(),
    when: when.code,
    whenLabel: when.label,
    eps: parseAmount(raw.epsForecast),
    lastEps: parseAmount(raw.lastYearEPS),
    marketCap,
    tier: capTier(marketCap),
    estimates: parseAmount(raw.noOfEsts),
    quarter: String(raw.fiscalQuarterEnding || "").trim(),
  };
}

export function normalizeImpact(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "high") return "High";
  if (s === "medium") return "Medium";
  if (s === "low") return "Low";
  if (s === "holiday") return "Holiday";
  return null;
}

// Does this event come from the Fed rather than a statistical agency? It is
// used for the "Fed only" filter -- it decides what is listed, never how
// important anything is.
const FED_RE = /\bFOMC\b|\bFed(eral)?\b|Powell|Beige Book|Federal Funds|Monetary Policy/i;

/**
 * The New York date an event falls on.
 *
 * US releases are scheduled in New York time, so an 8:30am print belongs to
 * that New York day whatever the reader's own clock says. Taken from the
 * instant rather than from the text of the timestamp, so the grouping stays
 * right even if the feed changes the offset it publishes.
 */
export function nyDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function econEvent(raw) {
  const at = raw?.date ? new Date(raw.date) : null;
  if (!at || isNaN(at)) return null;
  const title = String(raw.title || "").trim();
  if (!title) return null;
  return {
    key: `${at.toISOString()}|${title}`,
    at: at.toISOString(),
    date: nyDate(at),
    title,
    // The feed covers nine currencies; this page is about US markets, so the
    // caller filters on it. An Australian rate decision is a High in the feed
    // and has no bearing on a US equity option.
    country: String(raw.country || "").trim().toUpperCase() || null,
    impact: normalizeImpact(raw.impact),
    forecast: String(raw.forecast || "").trim() || null,
    previous: String(raw.previous || "").trim() || null,
    fed: FED_RE.test(title),
    source: "calendar",
  };
}

// The Fed's own release categories, mapped to a level. This mapping is the one
// judgement on the page, and it is made per CATEGORY -- which the Fed itself
// publishes on every release -- rather than per headline. An enforcement
// action against a small bank holding company is a Low whatever its title
// says; an FOMC statement is a High.
const FED_CATEGORY_IMPACT = {
  "monetary policy": "High",
  "banking and consumer regulatory policy": "Medium",
  "orders on banking applications": "Low",
  "enforcement actions": "Low",
  "other announcements": "Low",
};

export function fedImpact(category) {
  return FED_CATEGORY_IMPACT[String(category || "").trim().toLowerCase()] || null;
}

const unwrapCdata = (s) =>
  String(s || "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();

const decode = (s) =>
  unwrapCdata(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    // Ampersand last: doing it first would turn &amp;lt; into a real "<".
    .replace(/&amp;/g, "&");

const tagOf = (item, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item);
  return m ? decode(m[1]) : "";
};

/**
 * The Fed's press release feed.
 */
export function parseFedNews(xml) {
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/g) || [];
  const out = [];
  for (const item of items) {
    const title = tagOf(item, "title");
    const link = tagOf(item, "link");
    if (!title || !link) continue;
    const category = tagOf(item, "category");
    const published = new Date(tagOf(item, "pubDate"));
    out.push({
      key: link,
      title,
      link,
      category: category || null,
      impact: fedImpact(category),
      at: isNaN(published) ? null : published.toISOString(),
      source: "fed",
    });
  }
  return out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

const MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

const monthIndex = (name) => {
  const s = String(name || "").trim().toLowerCase();
  if (s.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3)));
};

const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The instant a New York event happens, as an ISO string.
 *
 * The FOMC statement and the minutes both go out at 2pm New York. That is
 * half past midnight the NEXT DAY in India, which is the whole reason this
 * exists: a bare date is read as a different day either side of the Atlantic,
 * and an Indian calendar dates the October minutes to the 19th where the Fed
 * dates them to the 18th. Both are the same moment.
 *
 * The offset is asked for per date rather than hard-coded, because New York
 * is five hours behind in November and four in July.
 */
export function nyInstant(dateIso, hh = 14, mm = 0) {
  const base = Date.parse(`${dateIso}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "longOffset",
  }).formatToParts(new Date(base + 12 * 3600000))
    .find((p) => p.type === "timeZoneName")?.value || "GMT-05:00";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offset = m
    ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    : -300;
  return new Date(base + (hh * 60 + mm - offset) * 60000).toISOString();
}

// The Fed's own policy: "Minutes of regularly scheduled meetings are released
// three weeks after the date of the policy decision." Every released date on
// the calendar page matches it exactly -- six out of six in 2026, each a
// Wednesday -- so a meeting whose minutes are still to come can be dated from
// it. Rows dated this way are marked, because a date the Fed has published and
// one derived from its policy are not the same kind of fact.
const MINUTES_LAG_DAYS = 21;

const addDays = (dateIso, n) =>
  new Date(Date.parse(`${dateIso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// "Minutes: PDF | HTML (Released October 07, 2026)" -> 2026-10-07
function releasedOn(cell) {
  const m = /Released\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(cell || ""));
  if (!m) return null;
  const mi = monthIndex(m[1]);
  return mi < 0 ? null : iso(Number(m[3]), mi, Number(m[2]));
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Scheduled FOMC meetings, from the Fed's own calendar page.
 *
 * Worth the parse because the week-ahead calendar cannot see this far: the
 * next rate decision is usually weeks out, which is exactly the horizon an
 * option position is written over.
 *
 * A meeting runs two days and the decision lands on the second, so the second
 * day is the date that matters. One straddling a month end is written as
 * "Apr/May 29-1", which is why the months and the days are paired off instead
 * of the pair being assumed to share a month. An asterisk marks the meetings
 * that also publish projections and hold a press conference.
 *
 * Each meeting carries its minutes too. They move the market in their own
 * right and fall three weeks later, so a meeting that is over still has
 * something ahead of it.
 */
export function parseFomcCalendar(html) {
  const text = String(html || "");
  const years = [...text.matchAll(/<a id="\d+">\s*(\d{4})\s+FOMC Meetings\s*<\/a>/g)];
  const out = [];

  for (const [i, match] of years.entries()) {
    const year = Number(match[1]);
    const start = match.index;
    const end = i + 1 < years.length ? years[i + 1].index : text.length;
    const slice = text.slice(start, end);

    const months = [...slice.matchAll(/fomc-meeting__month[^>]*>\s*(?:<strong>)?\s*([^<]+)/g)]
      .map((m) => m[1].trim());
    const days = [...slice.matchAll(/fomc-meeting__date[^>]*>\s*(?:<strong>)?\s*([^<]+)/g)]
      .map((m) => m[1].trim());
    const minuteCells = [...slice.matchAll(/fomc-meeting__minutes[^>]*>([\s\S]*?)<\/div>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

    for (let j = 0; j < Math.min(months.length, days.length); j++) {
      const projections = days[j].includes("*");
      const monthParts = months[j].split("/").map(monthIndex).filter((m) => m >= 0);
      const dayParts = days[j].replace(/[*\s]/g, "").split("-").map(Number).filter(Number.isFinite);
      if (!monthParts.length || !dayParts.length) continue;

      const firstMonth = monthParts[0];
      // Two months named means the meeting crosses the boundary, so the
      // closing day belongs to the second of them.
      const lastMonth = monthParts.length > 1 ? monthParts[1] : firstMonth;
      const firstDay = dayParts[0];
      const lastDay = dayParts.length > 1 ? dayParts[1] : firstDay;
      // A December/January meeting closes in the following year.
      const lastYear = lastMonth < firstMonth ? year + 1 : year;
      const decision = iso(lastYear, lastMonth, lastDay);

      const stated = releasedOn(minuteCells[j]);
      const minutesDate = stated || addDays(decision, MINUTES_LAG_DAYS);

      out.push({
        key: `fomc|${decision}`,
        starts: iso(year, firstMonth, firstDay),
        // The rate decision, which is the date to position around.
        date: decision,
        at: nyInstant(decision),
        label: `${firstDay}–${lastDay} ${SHORT_MONTHS[lastMonth]}`,
        projections,
        minutes: {
          date: minutesDate,
          at: nyInstant(minutesDate),
          // True where the Fed has published the date; false where it is
          // derived from the three-week rule.
          confirmed: Boolean(stated),
        },
      });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Meetings flattened into the events they actually produce, from `fromDate`.
 *
 * Each event is filtered on ITS OWN date. Filtering on the meeting would drop
 * the October meeting the day after its decision and take its 18 November
 * minutes down with it -- which is exactly what it did.
 */
export function fomcEvents(meetings, fromDate) {
  const from = String(fromDate || "");
  const out = [];

  for (const m of meetings || []) {
    out.push({
      key: m.key,
      kind: "decision",
      date: m.date,
      at: m.at,
      title: m.projections
        ? "FOMC rate decision, projections and press conference"
        : "FOMC rate decision",
      detail: `meets ${m.starts} – ${m.date}`,
      // A scheduled rate decision is the highest-impact event on the US
      // calendar. This is the event type, not a reading of a headline.
      impact: "High",
      confirmed: true,
      fed: true,
      source: "fomc",
    });
    if (m.minutes?.date) {
      out.push({
        key: `fomc-minutes|${m.minutes.date}`,
        kind: "minutes",
        date: m.minutes.date,
        at: m.minutes.at,
        title: `FOMC minutes — ${m.label} meeting`,
        detail: m.minutes.confirmed
          ? "date published by the Fed"
          : "three weeks after the decision, per Fed policy",
        // Minutes are a Monetary Policy release, which is the category this
        // page already rates High on the Fed's own feed.
        impact: "High",
        confirmed: m.minutes.confirmed,
        fed: true,
        source: "fomc",
      });
    }
  }

  return out
    .filter((e) => !from || e.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * "TUE 3 NOV" for a YYYY-MM-DD.
 *
 * Built from the parts, so the weekday comes from the date as written rather
 * than from an instant a timezone can drag back to the day before.
 */
export function dateLabel(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = DAYS[new Date(y, mo - 1, d).getDay()];
  return `${weekday} ${d} ${SHORT[mo - 1]}`;
}

/**
 * Rows grouped under their date, earliest first.
 */
export function groupByDate(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    const d = r?.date;
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items]) => ({ date, label: dateLabel(date), rows: items }));
}

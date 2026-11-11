// Where the Results page gets its data.
//
// Four public sources, none of which needs a key:
//
//   Nasdaq            the earnings calendar, one request per date.
//   ForexFactory      the economic calendar, with its own High/Medium/Low
//     (faireconomy)   ratings. Only the current week is published.
//   federalreserve    the FOMC meeting schedule, which is how the page can
//     .gov            show a rate decision that is weeks out -- the week-ahead
//                     calendar above simply cannot see that far.
//   federalreserve    the press release feed, each item carrying the Fed's own
//     .gov RSS        release category.
//
// All four are free endpoints that rate-limit, time out and occasionally
// refuse, and the page behind them refreshes itself every few minutes. So
// nothing here treats a failed refresh as a reason to show nothing: the last
// good answer is served with its age, and only a section that has never
// loaded reports an error. A section can fail alone, and the other three
// render regardless.

import { usMarketDate } from "./alpaca";
import {
  earningsRow,
  econEvent,
  parseFedNews,
  parseFomcCalendar,
} from "./results-calendar";

// Nasdaq's calendar API answers 403 to a bare fetch. It is a public endpoint
// serving a public web page; this is the header its own site sends.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NASDAQ = "https://api.nasdaq.com/api/calendar/earnings";
const CALENDAR = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FOMC_PAGE = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const FED_RSS = "https://www.federalreserve.gov/feeds/press_all.xml";

const MINUTE = 60_000;

// How long each source is held before a refresh is attempted. Generous,
// because none of this moves minute to minute: a company's reporting date and
// the FOMC schedule are set weeks out. The calendar feed rate-limits, so
// asking it more often than this buys a 429 rather than fresher data.
const TTL = {
  earnings: 30 * MINUTE,
  events: 15 * MINUTE,
  fomc: 12 * 60 * MINUTE,
  news: 15 * MINUTE,
};

const cache = new Map();

// Fetches currently in flight, keyed the same way as the cache. Two people
// opening the page at once, or one person on two devices, would otherwise each
// start their own request for the same thing -- which is how a service that
// allows a request every couple of minutes gets a burst and answers 429 to all
// of them. The first caller fetches and the rest wait on that same promise.
const inFlight = new Map();

/**
 * A cached read that prefers a stale answer to no answer.
 *
 * Returns the value with the time it was fetched and whether the latest
 * refresh failed. Only a key that has never loaded throws -- a 429 on the
 * fifth refresh of a page that was right four minutes ago is not news the
 * reader needs instead of the data.
 */
async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { value: hit.value, at: hit.at, stale: false };

  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const value = await load();
      cache.set(key, { at: Date.now(), value });
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  try {
    await pending;
    const fresh = cache.get(key);
    return { value: fresh.value, at: fresh.at, stale: false };
  } catch (err) {
    if (hit) return { value: hit.value, at: hit.at, stale: true, error: err.message };
    throw err;
  }
}

async function get(url, { json = true, timeout = 20_000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" },
      cache: "no-store",
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json ? res.json() : res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The next `days` calendar dates from today in New York, weekends dropped.
 *
 * Dated by the US market rather than by this server, which sits in Mumbai and
 * is already on tomorrow for half the US trading day -- "upcoming" there would
 * silently skip the session currently under way.
 *
 * Stepping in whole days over UTC midnights: a local-time step lands on 23:00
 * the previous day across a daylight-saving boundary and repeats a date.
 */
export function upcomingDates(days, from = usMarketDate()) {
  const start = Date.parse(`${from}T00:00:00Z`);
  if (!Number.isFinite(start)) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86_400_000);
    const weekday = d.getUTCDay();
    // Nasdaq answers for a weekend with an empty body, so skipping them loses
    // nothing and saves two requests in every seven.
    if (weekday === 0 || weekday === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Requests are run a few at a time. All thirty at once is a burst at a free
// public endpoint for no gain -- the page waits on the slowest either way, and
// a burst is what gets an IP rate-limited.
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function earningsForDate(date) {
  return cached(`earnings:${date}`, TTL.earnings, async () => {
    const body = await get(`${NASDAQ}?date=${date}`);
    // A date with nothing scheduled comes back with rows: null, which is an
    // answer -- not a failure, and not something to retry.
    const rows = body?.data?.rows;
    return (Array.isArray(rows) ? rows : [])
      .map((r) => earningsRow(r, date))
      .filter(Boolean);
  });
}

/**
 * Upcoming US earnings across the window.
 *
 * A date that could not be read at all is named rather than passed off as a
 * day with nothing scheduled: an empty Thursday and a Thursday that failed to
 * load look identical once drawn, and only one of them means there is nothing
 * to watch for.
 */
export async function fetchEarnings(days = 14) {
  const dates = upcomingDates(days);
  const failed = [];
  let oldest = null;
  let stale = false;

  const perDate = await inBatches(dates, 6, async (date) => {
    try {
      const got = await earningsForDate(date);
      if (got.stale) stale = true;
      oldest = oldest === null ? got.at : Math.min(oldest, got.at);
      return got.value;
    } catch {
      failed.push(date);
      return [];
    }
  });

  return { rows: perDate.flat(), dates, failed, at: oldest, stale };
}

/**
 * This week's US economic events, with the calendar's own impact ratings.
 */
export function fetchEvents() {
  return cached("events", TTL.events, async () => {
    const body = await get(CALENDAR);
    return (Array.isArray(body) ? body : [])
      .map(econEvent)
      .filter((e) => e && e.country === "USD")
      .sort((a, b) => a.at.localeCompare(b.at));
  });
}

/**
 * Scheduled FOMC meetings from today onwards.
 *
 * Re-filtered on every read rather than only on a fetch: the parse is held for
 * half a day, and a meeting that passes in the meantime must drop off the
 * page without waiting for the cache to turn over.
 */
export async function fetchFomc() {
  const got = await cached("fomc", TTL.fomc, async () => {
    const html = await get(FOMC_PAGE, { json: false, timeout: 25_000 });
    // Parsed without a cutoff so the cached value stays usable all day.
    return parseFomcCalendar(html, null);
  });
  const today = usMarketDate();
  return { ...got, value: (got.value || []).filter((m) => m.date >= today) };
}

/**
 * The Fed's own press releases, newest first.
 */
export function fetchFedNews() {
  return cached("news", TTL.news, async () => {
    const xml = await get(FED_RSS, { json: false });
    return parseFedNews(xml);
  });
}

// A section as the page consumes it. `stale` says the last refresh failed and
// this is the previous answer; `error` is only set where there is no answer at
// all, so the page never shows an error banner over good data.
const section = (got) => ({
  rows: got.value || [],
  fetchedAt: got.at ? new Date(got.at).toISOString() : null,
  stale: Boolean(got.stale),
  error: null,
});

const failedSection = (err) => ({ rows: [], fetchedAt: null, stale: false, error: err.message });

/**
 * Everything the page shows, with each section free to fail alone.
 */
export async function fetchResults({ days = 14 } = {}) {
  const [earnings, events, fomc, news] = await Promise.all([
    fetchEarnings(days).catch((e) => ({ error: e })),
    fetchEvents().then(section).catch(failedSection),
    fetchFomc().then(section).catch(failedSection),
    fetchFedNews().then(section).catch(failedSection),
  ]);

  return {
    asOf: new Date().toISOString(),
    marketDate: usMarketDate(),
    days,
    earnings: earnings.error
      ? failedSection(earnings.error)
      : {
          ...section({ value: earnings.rows, at: earnings.at, stale: earnings.stale }),
          // Named so the page can say "Thursday did not load" instead of
          // drawing an empty Thursday.
          failedDates: earnings.failed || [],
        },
    events,
    fomc,
    news,
  };
}

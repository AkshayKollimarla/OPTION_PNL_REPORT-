// Days a strategy's bot window shares with another strategy on the same coin.
//
// Strategy Analysis reports what the grid bot made over the days one strategy
// was open. That is the right answer for that strategy, but a day on which one
// strategy closed and the next opened belongs to both, so adding the
// per-strategy figures up counts it twice. MSTR's four September strategies
// summed to 290.83 against the 279.98 the token card reports; the difference
// was one shared day worth 10.85. Neither figure was wrong -- nothing said
// they answered different questions.

/**
 * Collapse legs into one window per strategy.
 *
 * A combined strategy is several rows sharing a group_id, and its window is
 * the earliest entry to the latest end. An open strategy has no end date and
 * runs to today.
 *
 * @param rows      trade rows: { id, group_id, token, account_id, entry_date, end_date }
 * @param canon     normalises a token to its base symbol
 * @param toDate    normalises a stored date to YYYY-MM-DD
 * @param today     YYYY-MM-DD, the end of an open strategy's window
 */
export function strategyWindows(rows, { canon, toDate, today }) {
  const units = new Map();
  for (const r of rows || []) {
    const from = toDate(r.entry_date);
    if (!from) continue;                       // undated: nothing to compare
    const key = r.group_id ? `g:${r.group_id}` : `s:${r.id}`;
    const to = toDate(r.end_date) || today;
    const u = units.get(key);
    if (!u) {
      units.set(key, {
        key, from, to,
        token: canon(r.token),
        // Kept as a string so 9 and "9" compare equal, and null stays null.
        accountId: r.account_id == null ? null : String(r.account_id),
      });
    } else {
      if (from < u.from) u.from = from;
      if (to   > u.to)   u.to   = to;
    }
  }
  return [...units.values()];
}

/**
 * The windows that overlap [from, to], clipped to it.
 *
 * Only strategies on the same coin AND the same options account count: a
 * strategy on another account is paired with a different bot account, so its
 * days are not these days.
 */
export function overlappingWindows({ selfKey, token, accountId, from, to, windows }) {
  if (!from || !to) return [];
  const self = { token, accountId: accountId == null ? null : String(accountId) };
  return (windows || [])
    .filter((w) => w.key !== selfKey && w.token === self.token && w.accountId === self.accountId)
    .map((w) => ({ key: w.key, from: w.from > from ? w.from : from, to: w.to < to ? w.to : to }))
    .filter((w) => w.from <= w.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/**
 * The days inside those overlaps on which the bot actually traded, and what
 * they were worth. A day is listed once however many strategies share it --
 * the warning is about the day, not about how popular it is. An overlap over
 * days the bot sat out is worth nothing and is not reported.
 *
 * @param dayValues Map of YYYY-MM-DD -> net pnl for that day
 */
export function sharedBotDays(overlaps, dayValues) {
  const days = new Map();
  for (const o of overlaps || []) {
    for (const [date, value] of dayValues || []) {
      if (date >= o.from && date <= o.to) days.set(date, Number(value) || 0);
    }
  }
  return [...days].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

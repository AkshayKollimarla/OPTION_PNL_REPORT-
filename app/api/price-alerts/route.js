import { NextResponse } from "next/server";
import optionsPool from "../../../lib/options-db";
import { deriveLimits, triggersFor, priceLooksRelated, DEFAULT_OFFSET } from "../../../lib/price-alerts";
import { hyperliquidMids, priceFor, coinOf } from "../../../lib/price-feed";
import { ensureAlertTable, loadSettings } from "../../../lib/price-alert-store";

export const dynamic = "force-dynamic";

/**
 * The watch list: one row per OPEN options strategy, with the band it is
 * protected inside, where its alerts sit, and what the coin is trading at
 * now.
 *
 * Built from the strategies rather than stored, so a structure opened or
 * closed on the Options Dashboard appears here or leaves without anything
 * being kept in step by hand. Only the overrides are saved.
 */
export async function GET() {
  try {
    await ensureAlertTable();

    const [legs] = await optionsPool.query(`
      SELECT t.id, t.group_id, t.token, t.option_type, t.opt_entry_qty, t.options_strike,
             t.fut_entry_price, t.upside_distance, t.down_distance, t.account_id,
             DATE_FORMAT(t.expiry, '%Y-%m-%d')     AS expiry,
             DATE_FORMAT(t.entry_date, '%Y-%m-%d') AS entry_date,
             a.name AS account, a.api_key, a.api_secret
        FROM options_trades t
        LEFT JOIN trading_accounts a ON a.id = t.account_id
       WHERE t.status = 'open'
       ORDER BY t.token, t.group_id, COALESCE(t.leg_index, t.id)`);

    // One row per strategy, not per leg.
    const groups = new Map();
    for (const l of legs) {
      const key = l.group_id ? `g:${l.group_id}` : `s:${l.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }

    const settings = await loadSettings();
    const mids = await hyperliquidMids();

    const rows = [];
    for (const [key, group] of groups) {
      const first = group[0];
      const limits = deriveLimits(group);
      const saved = settings.get(key) || {};
      const triggers = triggersFor(limits, {
        offset: saved.offset_usd ?? DEFAULT_OFFSET,
        alertUpper: saved.alert_upper,
        alertLower: saved.alert_lower,
      });

      const { price, source, error, delayedMinutes } = await priceFor({
        token: first.token,
        credential: first.api_key ? { api_key: first.api_key, api_secret: first.api_secret } : null,
        mids,
      });

      rows.push({
        key,
        group_id: first.group_id,
        token: first.token,
        coin: coinOf(first.token),
        account: first.account,
        legs: group.length,
        entry_date: first.entry_date,
        expiry: first.expiry,
        // Spread apart, not merged: both carry `upper` and `lower`, and
        // spreading triggers over limits silently replaced the band with the
        // alert levels -- the page would have shown the trigger as the limit.
        upper: limits.upper,
        lower: limits.lower,
        upperFrom: limits.upperFrom,
        lowerFrom: limits.lowerFrom,
        futPrice: limits.futPrice,
        upperTrigger: triggers.upper,
        lowerTrigger: triggers.lower,
        upperManual: triggers.upperManual,
        lowerManual: triggers.lowerManual,
        offset: triggers.offset,
        enabled: saved.enabled === undefined ? true : !!saved.enabled,
        price,
        priceSource: source,
        priceError: error || null,
        delayedMinutes: delayedMinutes ?? null,
        // Stated rather than silently ignored: a price nowhere near the band
        // is almost certainly a different market of the same name.
        priceMismatch: price != null && !priceLooksRelated(price, limits),
        lastFiredAt: saved.last_fired_at || null,
      });
    }

    rows.sort((a, b) => a.coin.localeCompare(b.coin) || String(a.entry_date).localeCompare(String(b.entry_date)));
    return NextResponse.json({ rows, telegram: settings.telegram });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Save the overrides for one strategy. */
export async function PUT(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }

  const { saveSettings } = await import("../../../lib/price-alert-store");
  try {
    await ensureAlertTable();
    await saveSettings(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

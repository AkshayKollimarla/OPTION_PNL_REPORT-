import { NextResponse } from "next/server";
import { buildRows, quoteSymbol } from "../../../lib/price-alert-rows";
import {
  ensureAlertTable, saveSettings, addManual, removeManual, forgetSettings,
} from "../../../lib/price-alert-store";

export const dynamic = "force-dynamic";

/**
 * The watch list: every open strategy, plus every alert added by hand, each
 * with its band, where its alerts sit, and what it is trading at now.
 *
 * ?quote=SYMBOL instead prices one symbol, so the add form can show what it
 * is about to watch -- and say when nothing quotes it -- before anything is
 * saved.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const quote = (searchParams.get("quote") || "").trim();

  try {
    await ensureAlertTable();
    if (quote) {
      const { price, source, error, delayedMinutes } = await quoteSymbol(quote);
      return NextResponse.json({
        token: quote.toUpperCase(),
        price, source,
        error: error || null,
        delayedMinutes: delayedMinutes ?? null,
      });
    }
    return NextResponse.json(await buildRows());
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/** Add an alert for any symbol. */
export async function POST(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  try {
    await ensureAlertTable();
    const key = await addManual(body);
    return NextResponse.json({ ok: true, key }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

/** Change the thresholds on an existing alert, of either kind. */
export async function PUT(request) {
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  try {
    await ensureAlertTable();
    await saveSettings(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * Delete what was saved.
 *
 * A manual alert goes altogether -- it exists only because it was added. A
 * strategy's row cannot: it is the strategy, and it leaves when that closes.
 * Deleting one there drops the thresholds that were saved for it, so it goes
 * back to following its own limits.
 */
export async function DELETE(request) {
  const { searchParams } = new URL(request.url);
  const key = (searchParams.get("key") || "").trim();
  if (!key) return NextResponse.json({ error: "A key is required." }, { status: 400 });
  try {
    await ensureAlertTable();
    if (key.startsWith("m:")) {
      await removeManual(key);
      return NextResponse.json({ ok: true, removed: "alert" });
    }
    const n = await forgetSettings(key);
    return NextResponse.json({ ok: true, removed: n ? "settings" : "nothing" });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

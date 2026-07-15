/**
 * Telegram alert sender for the auto-close worker.
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from .env — never throws, so
 * callers can fire-and-forget without extra try/catch. Returns
 * { ok: boolean, error?: string } so callers can persist the outcome
 * somewhere visible (e.g. a job's log_json) instead of it only ever showing
 * up in ephemeral terminal output that's gone by the time anyone checks.
 */

export async function sendTelegramAlert(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    const error = "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env — skipping alert";
    console.warn(`[telegram] ${error}`);
    return { ok: false, error };
  }
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error("[telegram] send failed:", json.description);
      return { ok: false, error: json.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[telegram] send error:", e.message);
    return { ok: false, error: e.message };
  }
}

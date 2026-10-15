export async function register() {
  // Only run the background worker in Node.js (not in Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/auto-close-worker.js");
    startWorker();

    // Watches the open strategies and messages Telegram when a coin nears a
    // limit. Separate worker, separate poll: an alert must keep arriving even
    // if the auto-close loop is idle or wedged.
    const { startWorker: startPriceAlerts } = await import("./lib/price-alert-worker.js");
    startPriceAlerts();
  }
}

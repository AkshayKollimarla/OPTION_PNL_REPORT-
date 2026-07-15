export async function register() {
  // Only run the background worker in Node.js (not in Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/auto-close-worker.js");
    startWorker();
  }
}

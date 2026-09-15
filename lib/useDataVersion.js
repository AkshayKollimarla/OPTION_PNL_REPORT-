"use client";

import { useEffect, useRef } from "react";

// Calls `onChange` whenever the data behind the reports changes — from this
// tab, another tab, another device, or a server-side worker.
//
// Watches /api/data-version, a checksum of the tables the reports read.
//
//  - Checked immediately when the tab comes back into view. That is the case
//    that matters most: edit a strategy in one tab, switch to the report in
//    another, and it is already reloading as you arrive.
//  - Polled while the tab is visible, so two pages side by side stay in step
//    without either being touched.
//  - Paused while the tab is hidden. A background tab has no one reading it,
//    and the visibility check catches it up the moment someone does.
//
// The first version seen is only a baseline and never fires — a page that has
// just loaded is already current.
export default function useDataVersion(onChange, { intervalMs = 10_000 } = {}) {
  const lastRef = useRef(null);
  const cbRef = useRef(onChange);
  useEffect(() => { cbRef.current = onChange; }, [onChange]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let inFlight = false;

    async function check() {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const res = await fetch("/api/data-version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = await res.json();
        if (cancelled || !version) return;
        if (lastRef.current !== null && lastRef.current !== version) {
          cbRef.current?.();
        }
        lastRef.current = version;
      } catch {
        // A missed check is harmless: the next one catches up.
      } finally {
        inFlight = false;
      }
    }

    function schedule() {
      clearInterval(timer);
      timer = setInterval(check, intervalMs);
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") { check(); schedule(); }
      else clearInterval(timer);
    };

    check();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [intervalMs]);
}

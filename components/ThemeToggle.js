"use client";

import { useEffect, useState } from "react";

// Light/dark switch. The actual theme lives as a `dark` class on <html>,
// applied by the inline script in layout.js before first paint — this
// component only reads and flips it, so there is never a moment where the
// button and the page disagree.
//
// `mounted` guards against a hydration mismatch: the server has no idea which
// theme this browser stored, so the knob renders in its neutral position
// until the client has looked.
export default function ThemeToggle({ compact = false }) {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // Private browsing or blocked storage: the theme still applies for
      // this page view, it just will not be remembered.
    }
  }

  const label = dark ? "Switch to light mode" : "Switch to dark mode";

  if (compact) {
    return (
      <button
        type="button"
        onClick={toggle}
        title={label}
        aria-label={label}
        className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:text-slate-700 dark:border-white/10"
      >
        {mounted && dark ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={mounted ? dark : undefined}
      title={label}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
    >
      {mounted && dark ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
      <span className="flex-1 text-left">{mounted && dark ? "Light mode" : "Dark mode"}</span>

      {/* Track + knob. Kept on transform so the slide stays smooth. */}
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          mounted && dark ? "bg-brand" : "bg-white/15"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[#ffffff] shadow transition-transform ${
            mounted && dark ? "translate-x-[1.125rem]" : "translate-x-[0.1875rem]"
          }`}
        />
      </span>
    </button>
  );
}

function SunIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

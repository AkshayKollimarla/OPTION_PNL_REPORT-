"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Logo from "./Logo";

/**
 * The frame every page sits in.
 *
 * On a phone the sidebar is a drawer rather than a column: 240px of permanent
 * navigation on a 390px screen left the actual page with a third of the width,
 * which is what made this unusable on a phone. A bar at the top carries the
 * mark and the button that opens it.
 */
export default function AppShell({ children }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // Following a link closes the drawer. Without this it stays over the page
  // that was just opened, and the first tap after navigating goes to the
  // backdrop instead of the content.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // The page behind must not scroll while the drawer is over it.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [navOpen]);

  if (pathname === "/login") return <>{children}</>;

  return (
    <div className="flex min-h-screen">
      {/* Permanent from lg up; a drawer below it. */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {navOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-slate-900/60 lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 flex lg:hidden">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </>
      )}

      <main className="flex-1 min-w-0 bg-slate-50">
        {/* The phone's own header: the mark, and the way back to navigation. */}
        <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <Logo className="h-7 w-7" />
          <span className="text-sm font-semibold tracking-wide text-slate-800">STRING TRADING</span>
        </div>

        {children}
      </main>
    </div>
  );
}

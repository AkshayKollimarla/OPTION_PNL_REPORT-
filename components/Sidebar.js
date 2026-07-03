"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const nav = [
  { href: "/",               label: "Dashboard",      icon: GridIcon   },
  { href: "/summary-report", label: "Summary Report", icon: ReportIcon },
  { href: "/manual-entry",   label: "Entry Fields",   icon: PlusIcon   },
  { href: "/entries-log",    label: "Entries Log",    icon: ListIcon   },
  { href: "/analysis",       label: "Analysis",       icon: ChartIcon  },
];

const optionsNav = [
  { href: "/options",            label: "Options Dashboard",   icon: OptionsIcon    },
  { href: "/options/add",        label: "Add Strategy",        icon: PlusIcon       },
  { href: "/options/simulator",  label: "Combined Simulator",  icon: SimulatorIcon  },
  { href: "/options/analysis",   label: "Options Analysis",    icon: ChartIcon      },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router   = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="w-60 shrink-0 bg-navy text-slate-300 flex flex-col">
      <div className="flex items-center gap-2 px-5 h-16 border-b border-white/10">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white font-bold">
          ▲
        </div>
        <span className="text-white font-semibold tracking-wide">GridBot</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link key={href} href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                active ? "bg-brand text-white shadow" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}

        {/* Options Strategy section */}
        <div className="pt-3">
          <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-widest text-slate-500">
            Options Strategy
          </p>
          {optionsNav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active ? "bg-brand text-white shadow" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
                <Icon className="h-5 w-5" />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-3 py-4 border-t border-white/10 space-y-2">
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-red-500/20 hover:text-red-300 transition-colors"
        >
          <LogoutIcon className="h-5 w-5" />
          Logout
        </button>
        <p className="px-2 text-xs text-slate-600">Trading Bot Analytics</p>
      </div>
    </aside>
  );
}

function GridIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function PlusIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 8v8M8 12h8" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 6h13M8 12h13M8 18h13" strokeLinecap="round" />
      <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChartIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" strokeLinecap="round" />
      <path d="M7 16l4-4 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OptionsIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinejoin="round" />
      <path d="M2 17l10 5 10-5" strokeLinecap="round" />
      <path d="M2 12l10 5 10-5" strokeLinecap="round" />
    </svg>
  );
}

function SimulatorIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReportIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M8 7h8M8 11h8M8 15h5" strokeLinecap="round" />
    </svg>
  );
}

function LogoutIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" strokeLinecap="round" />
      <polyline points="16 17 21 12 16 7" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="21" y1="12" x2="9" y2="12" strokeLinecap="round" />
    </svg>
  );
}

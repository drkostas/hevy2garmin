"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "◉" },
  { href: "/workouts", label: "Workouts", icon: "≡" },
  { href: "/routines", label: "Routines", icon: "◱" },
  { href: "/mappings", label: "Mappings", icon: "⇄" },
  { href: "/history", label: "History", icon: "◷" },
  { href: "/settings", label: "Settings", icon: "⚙" },
  { href: "/setup", label: "Setup", icon: "⇆" },
];

export function NavBar({ authEnabled = false }: { authEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // Hide the whole bar on the login screen.
  if (pathname === "/login") return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      // ignore — navigate to login regardless
    }
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* Desktop: top bar */}
      <nav className="hidden md:flex items-center justify-between px-6 py-3 bg-surface-elevated border-b border-border sticky top-0 z-40">
        <Link href="/dashboard" className="text-lg font-bold text-text">
          hevy2garmin
        </Link>
        <div className="flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                isActive(href)
                  ? "bg-warm/20 text-warm font-medium"
                  : "text-text-secondary hover:text-text hover:bg-surface-hover"
              }`}
            >
              {label}
            </Link>
          ))}
          {authEnabled && (
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut}
              className="ml-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-active disabled:opacity-50"
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          )}
        </div>
      </nav>

      {/* Mobile: bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around bg-surface-elevated border-t border-border py-2 pb-[env(safe-area-inset-bottom)]">
        {NAV_ITEMS.map(({ href, label, icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 min-w-[52px] ${
              isActive(href) ? "text-teal" : "text-text-muted"
            }`}
          >
            <span className="text-lg">{icon}</span>
            <span className="text-[10px] font-medium">{label}</span>
          </Link>
        ))}
        {authEnabled && (
          <button
            type="button"
            onClick={logout}
            disabled={loggingOut}
            className="flex flex-col items-center gap-0.5 px-2 py-1 min-w-[52px] text-text-muted disabled:opacity-50"
          >
            <span className="text-lg">⏻</span>
            <span className="text-[10px] font-medium">Log out</span>
          </button>
        )}
      </nav>
    </>
  );
}

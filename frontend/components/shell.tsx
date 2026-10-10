"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAppState, type App } from "./app-context";
import { SignIn } from "./sign-in";
import { TraceDrawer } from "./trace-drawer";

/* The frame around every page: the top bar, the page itself, and the trace drawer. Pages are rendered only
   once someone has signed in and /api/meta has loaded, because everything they show is labelled with roles
   and tags from it. Until then the frame shows the sign-in form in the page's place, so a deep link still
   opens the page it names once the person is in. */

const PAGES = ["ask", "catalog", "lineage", "crosswalk", "quality", "access"];

export function Shell({ children }: { children: ReactNode }) {
  const { app, error, signedOut } = useAppState();
  const page = usePathname().split("/").filter(Boolean)[0] ?? "ask";
  // the tab is a convenience: the server refuses the accounts routes to anyone but an administrator
  const pages = app?.canManageAccounts ? [...PAGES, "accounts"] : PAGES;
  return (
    <>
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-5 sm:px-5 sm:py-0">
        <Link href="/ask" className="flex items-center gap-[9px] text-base font-bold tracking-[-.01em] text-ink hover:no-underline">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect width="32" height="32" rx="8" className="fill-accent" />
            <path d="M22 11a8 8 0 1 0 0 10" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
            <circle cx="22" cy="16" r="2.4" fill="#fff" />
          </svg>
          <span>Concord</span>
        </Link>
        {app && (
          <nav className="order-3 flex w-full gap-0.5 overflow-x-auto sm:order-none sm:w-auto sm:overflow-visible">
            {pages.map((p) => (
              <Link key={p} href={`/${p}`} aria-current={p === page ? "page" : undefined}
                className={`rounded-[7px] px-[11px] py-[7px] font-medium capitalize hover:no-underline ${p === page ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-surface-2"}`}>
                {p}
              </Link>
            ))}
          </nav>
        )}
        {app && (
          <div className="ml-auto flex items-center gap-4">
            <Feeds app={app} />
            <AccountMenu app={app} onProfile={page === "profile"} />
          </div>
        )}
      </header>
      <main className={`mx-auto px-3 pb-[60px] pt-4 sm:px-5 sm:pb-20 sm:pt-[26px] ${page === "lineage" ? "max-w-[1760px]" : "max-w-[1240px]"}`}>
        {app ? children : (
          <>
            {error && (
              <div className="rounded-[9px] border border-bad/25 bg-bad-soft px-3.5 py-2.5 text-[13.5px]">
                Concord&apos;s API is not responding: {error}
              </div>
            )}
            {signedOut && <SignIn />}
          </>
        )}
      </main>
      {app && <TraceDrawer />}
    </>
  );
}

/* One dot per source feed, amber when it is past its freshness SLA. */
function Feeds({ app }: { app: App }) {
  return (
    <div className="hidden gap-1.5 xl:flex" title="Source feeds">
      {app.meta.feeds.map((f) => (
        <span key={f.system} title={`${f.system_name} · extracted ${f.extracted_at.replace("T", " ")}${f.is_stale ? " · STALE" : ""}`}
          className={`flex items-center gap-[5px] rounded-full border px-2 py-[3px] text-[11.5px] font-semibold uppercase tracking-[.04em] before:size-[7px] before:rounded-full ${
            f.is_stale ? "border-warn bg-warn-soft text-warn before:bg-warn" : "border-line text-ink-2 before:bg-good"}`}>
          {f.system}
        </span>
      ))}
    </div>
  );
}

/* Who is signed in. The name opens the profile page; the role under it is the account's, set by an administrator. */
function AccountMenu({ app, onProfile }: { app: App; onProfile: boolean }) {
  return (
    <div className="flex items-center gap-0.5 rounded-[9px] bg-surface-2 p-[3px]">
      <Link href="/profile" title="Your profile" aria-current={onProfile ? "page" : undefined}
        className="whitespace-nowrap rounded-[7px] bg-surface px-[11px] py-1 leading-[1.2] text-ink-2 shadow-card hover:no-underline">
        <b className="block text-[12.5px] font-bold text-accent-ink">{app.person}</b>
        <span className="hidden text-[11px] md:inline">{app.roleName}</span>
      </Link>
      <button type="button" onClick={app.signOut} className="whitespace-nowrap rounded-[7px] px-[11px] py-1 text-[12.5px] font-semibold text-ink-2 hover:text-ink">
        Sign out
      </button>
    </div>
  );
}

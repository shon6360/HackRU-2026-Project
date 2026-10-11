"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtInt, plural } from "@/lib/format";
import type { Trace } from "@/lib/types";
import { useApp } from "./app-context";
import { DataTable } from "./data-table";
import { Lock, MatchTable, NodeRef, Notice, Spinner, SysBadge } from "./ui";

/* Where does this key come from? How each system's id was matched to it, then the raw source rows, exactly
   as exported. Shared by every page: any TraceLink opens it. Withheld blocks are shown as withheld. */
export function TraceDrawer() {
  const { trace, closeTrace, person, roleName } = useApp();
  const [loaded, setLoaded] = useState<{ key: string; data?: Trace; error?: string } | null>(null);
  const key = trace ? `/api/trace?column=${encodeURIComponent(trace.column)}&value=${encodeURIComponent(trace.value)}` : null;

  useEffect(() => {
    if (!key) return;
    let live = true;
    api<Trace>(key).then(
      (data) => { if (live) setLoaded({ key, data }); },
      (e: Error) => { if (live) setLoaded({ key, error: e.message }); },
    );
    return () => { live = false; };
  }, [key]);

  useEffect(() => {
    if (!trace) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeTrace(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [trace, closeTrace]);

  if (!trace) return null;
  const current = loaded?.key === key ? loaded : null;  // never show the previous key's rows under a new title
  const t = current?.data;
  const problem = current?.error ?? t?.error;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-[rgba(15,23,42,.35)]" onClick={closeTrace} />
      <aside className="fixed inset-y-0 right-0 z-[31] flex w-[min(780px,94vw)] flex-col border-l border-line bg-bg shadow-[-8px_0_30px_rgba(0,0,0,.14)]">
        <div className="flex items-center justify-between border-b border-line bg-surface px-[18px] py-3.5">
          <h2 className="m-0">Where does <code>{trace.value}</code> come from?</h2>
          <button type="button" aria-label="Close" onClick={closeTrace} className="rounded-md px-2 py-0.5 text-2xl leading-none text-ink-2 hover:bg-surface-2">&times;</button>
        </div>
        <div className="overflow-auto px-[18px] pb-10 pt-4">
          {!current ? <Spinner /> : problem ? <Notice kind="bad">{problem}</Notice> : t && (
            <>
              <p className="text-ink-2">Seen as {person}, {roleName}. Raw rows are shown exactly as the source system exported them.</p>
              {t.crosswalk && (
                <>
                  <h3>How each system&apos;s id was matched to <code>{trace.value}</code></h3>
                  {t.crosswalk.denied ? <Notice kind="policy" icon={<Lock />}>The crosswalk is {t.crosswalk.denied}.</Notice> : <MatchTable ids={t.crosswalk.rows ?? []} />}
                </>
              )}
              <h3 className="mt-5">Source rows</h3>
              {!t.sources?.length && <p className="text-ink-2">No source rows found.</p>}
              {(t.sources ?? []).map((s) => (
                <div key={s.dataset} className="mt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <NodeRef id={s.dataset} onClick={closeTrace} />
                    {s.system && <SysBadge system={s.system} />}
                    {!!s.total && (
                      <span className="text-[12.5px] text-ink-2">
                        {fmtInt(s.total)} {plural(s.total, "row")}{s.rows && s.total > s.rows.length ? `, first ${s.rows.length} shown` : ""}
                      </span>
                    )}
                  </div>
                  {s.denied ? <Notice kind="policy" icon={<Lock />} className="mt-1.5">Withheld: {s.denied}.</Notice> : s.rows && s.columns && (
                    <>
                      <div className="mb-1.5 mt-1 font-mono text-[12px] text-ink-2">{s.file} &rarr; {s.bronze}</div>
                      <DataTable rows={s.rows} masked={s.masked}
                        columns={s.columns.map((c) => c === "_src_row" ? { name: c, label: "row #", type: "BIGINT" } : { name: c, type: "VARCHAR" })} />
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp, type AnswerTab } from "@/components/app-context";
import { DataTable } from "@/components/data-table";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Btn, Card, Chip, Empty, Joined, Lock, NodeRef, Notice, NoticeList, Pill, Sev, Spinner, SysBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtStamp, plural } from "@/lib/format";
import type { Answer, Comparison, Role } from "@/lib/types";

/* An answer and everything attached to it: how the SQL came about, what was withheld from this role, what
   might make the numbers wrong, and four tabs (result, SQL, lineage, what the policy decides for every role). */
export function AnswerPanel({ onPick }: { onPick: (question: string) => void }) {
  const { answer: a, pending, tab, setTab, meta, role, person } = useApp();
  if (pending === "ask") return <Card pad><Spinner /> &nbsp;Working out which systems hold the answer…</Card>;
  if (!a) return null;

  if (!a.sql && !a.error) {  // nothing matched, or the model declined
    return (
      <Card pad>
        <div className="text-[16px] font-[650]">{a.question}</div>
        <p className="mt-1.5 text-ink-2">{a.explanation || "No answer."}</p>
        {a.model_error && <p className="text-[12.5px] text-ink-3">Model error: {a.model_error}</p>}
        <h3 className="mt-3.5">Reviewed questions you can ask</h3>
        <div className="flex flex-wrap gap-2">{(a.suggestions ?? []).map((s) => <Chip key={s} onClick={() => onPick(s)}>{s}</Chip>)}</div>
      </Card>
    );
  }

  // the card names the role the answer was run as: the server reads it from the account on every request
  const ran = meta.roles[a.role ?? role] ?? meta.roles[role];
  const systems = [...new Set((a.context?.feeds ?? []).map((f) => f.system))];
  const count = !a.denied && !a.error && a.row_count !== undefined ? ` · ${a.row_count}${a.truncated ? "+" : ""}` : "";
  const tabs: [AnswerTab, string][] = [["result", `Result${count}`], ["sql", "SQL"], ["lineage", "Lineage"], ["roles", "Compare roles"]];

  return (
    <>
      {pending === "sql" && <div className="mb-2 text-[12.5px] text-ink-2"><Spinner /> Running as {person}…</div>}
      <Card>
        <div className="border-b border-line px-[18px] pb-3 pt-4">
          <div className="mb-1.5 text-[17px] font-[650] tracking-[-.01em]">{a.question || "SQL query"}</div>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {a.mode === "vetted" ? <Pill tone="good">Reviewed query</Pill> : a.mode === "model" ? <Pill tone="accent">SQL written by {a.model}</Pill> : <Pill>Your SQL</Pill>}
            <span className="text-ink-2">as <b>{person}</b>, {ran.name}</span>
            {systems.length > 0 && <span className="text-ink-2">· reads <Joined sep=" " items={systems.map((s) => <SysBadge key={s} system={s} />)} /></span>}
            {a.elapsed_ms !== undefined && <span className="text-ink-3">· {a.elapsed_ms} ms</span>}
          </div>
          {a.matched_question && a.matched_question !== a.question && (
            <p className="mb-0 mt-2 text-[12.5px] text-ink-2">Closest reviewed question: “{a.matched_question}”. {a.note}</p>
          )}
          {a.explanation && a.mode !== "sql" && <p className="mb-0 mt-2">{a.explanation}</p>}
        </div>
        <div className="space-y-3.5 px-[18px] py-3.5">
          <PolicyNotices a={a} ran={ran} person={person} />
          {a.error && <Notice kind="bad" icon="×"><b>The query did not run.</b> {a.error}</Notice>}
          {!a.denied && !a.error && <TrustNotices a={a} />}
        </div>
        <div className="flex gap-1 border-b border-line px-3.5">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-[11px] py-[9px] font-semibold ${tab === id ? "border-accent text-accent-ink" : "border-transparent text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="px-[18px] pb-[18px] pt-3.5">
          {tab === "result" && <ResultTab a={a} />}
          {tab === "sql" && <SqlTab key={a.sql} a={a} />}
          {tab === "lineage" && <LineageTab a={a} />}
          {tab === "roles" && <CompareTab a={a} />}
        </div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ notices */
/* What the policy did to this query. The front end enforces nothing: it reports the decisions the server made. */
function PolicyNotices({ a, ran, person }: { a: Answer; ran: Role; person: string }) {
  const denies = (a.decisions ?? []).filter((d) => d.action === "deny");
  const masks = (a.decisions ?? []).filter((d) => d.action === "mask");
  return (
    <>
      {denies.length > 0 && (
        <Notice kind="bad" icon={<Lock />}>
          <b>{person} cannot run this question.</b> It needs data the {ran.name} role is not allowed to see, so nothing was executed.
          <NoticeList>{denies.map((d) => <li key={d.object}><code>{d.object}</code> is {d.reason}.</li>)}</NoticeList>
        </Notice>
      )}
      {masks.length > 0 && (
        <Notice kind="policy" icon={<Lock />}>
          <b>{masks.length} {plural(masks.length, "column")} withheld from {person}.</b>{" "}
          The query ran, but these come back empty for this role{a.row_count === 0 ? ", which is why a filter on them matches nothing" : ""}.
          <NoticeList>{masks.map((d) => <li key={d.object}><code>{d.object}</code> is {d.reason}.</li>)}</NoticeList>
        </Notice>
      )}
    </>
  );
}

/* Stale feeds and failing quality rules on the data behind the answer. */
function TrustNotices({ a }: { a: Answer }) {
  return (
    <>
      {(a.context?.warnings ?? []).map((w, i) => {
        if (w.kind === "stale") return <Notice key={i} kind="warn" icon="!">{w.text}</Notice>;
        const rules = w.rules ?? [];
        return (
          <Notice key={i} kind="warn" icon="!">
            {w.text} <Link href="/quality">Open the quality page</Link>
            <details>
              <summary className="mt-[3px] text-[12.5px] text-ink-2">Show the {rules.length} failing {plural(rules.length, "rule")}</summary>
              <NoticeList>{rules.map((r) => <li key={r.rule_id}>{r.title}: {r.n_failed} <Sev severity={r.severity} /></li>)}</NoticeList>
            </details>
          </Notice>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ tabs */
function ResultTab({ a }: { a: Answer }) {
  if (a.denied) return <Empty>Nothing to show. Open <b>Compare roles</b> to see which roles can run this.</Empty>;
  if (a.error) return <Empty>Fix the query under the <b>SQL</b> tab and run it again.</Empty>;
  if (!a.rows?.length) return <Empty>The query ran and returned no rows.</Empty>;
  const traceable = a.traceable ?? [];
  return (
    <>
      <DataTable columns={a.columns ?? []} rows={a.rows} masked={a.masked_columns} traceable={traceable} />
      <p className="mx-0.5 mb-0 mt-2 text-[12.5px] text-ink-3">
        {traceable.length > 0 && <>Click any underlined <Joined items={traceable.map((c) => <code key={c}>{c}</code>)} /> to see the source rows behind it. </>}
        {a.truncated && "Showing the first 500 rows."}
      </p>
    </>
  );
}

function SqlTab({ a }: { a: Answer }) {
  const { runSql, person } = useApp();
  const [sql, setSql] = useState(a.sql ?? "");
  const tables = a.tables ?? [];
  return (
    <>
      <p className="text-[12.5px] text-ink-2">
        This is exactly what ran. Edit it and run it again: your SQL goes through the same policy check and the same sandboxed database, which holds only what your role is granted.
      </p>
      <textarea className="min-h-[150px] resize-y whitespace-pre font-mono text-[12.5px] leading-[1.55]" spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Btn primary size="sm" onClick={() => runSql(sql, { ...a, edited: true })}>Run as {person}</Btn>
        <span className="text-[12.5px] text-ink-3">Tables used: {tables.length ? <Joined items={tables.map((t) => <NodeRef key={t} id={t} />)} /> : "none"}</span>
      </div>
    </>
  );
}

function LineageTab({ a }: { a: Answer }) {
  if (!a.context) return <Empty>No lineage: the query did not parse.</Empty>;
  return (
    <>
      <p className="text-[12.5px] text-ink-2">
        Every table and source file this answer was built from.{" "}
        <Joined sep=" · " items={a.context.feeds.map((f) => (
          <span key={f.system}><SysBadge system={f.system} /> extracted {fmtStamp(f.extracted_at)}{f.is_stale && <> <Pill tone="warn">stale</Pill></>}</span>
        ))} />
      </p>
      <Legend />
      <LineageGraph graph={a.context.graph} markTargets />
    </>
  );
}

/* What the policy decides about this SQL for each role. The server only checks the query against each role's
   tags: it is run for the signed-in account alone, so nobody is shown another role's rows. Kept per answer,
   so reopening the tab does not ask again. */
const compared = new WeakMap<Answer, Promise<Comparison>>();

function CompareTab({ a }: { a: Answer }) {
  const { meta, role: mine } = useApp();
  const [done, setDone] = useState<{ a: Answer; result: Comparison } | null>(null);

  useEffect(() => {
    let live = true;
    let run = compared.get(a);
    if (!run) {
      run = api<Comparison>("/api/compare", { sql: a.sql }).catch((e: Error): Comparison => ({ error: e.message, roles: [] }));
      compared.set(a, run);
    }
    run.then((result) => { if (live) setDone({ a, result }); });
    return () => { live = false; };
  }, [a]);

  return (
    <>
      <p className="text-[12.5px] text-ink-2">
        What the policy decides about this SQL for each role. Only your own role&apos;s answer is run: to see another role&apos;s rows you sign in to an account that holds it.
      </p>
      {done?.a !== a ? <Spinner /> : done.result.error ? <Empty>{done.result.error}</Empty> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {done.result.roles.map((r) => {
            const masks = r.decisions.filter((d) => d.action === "mask");
            const denies = r.decisions.filter((d) => d.action === "deny");
            return (
              <Card key={r.role} pad flat>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-[13.5px]">{meta.roles[r.role].name}</h4>
                  {r.role === mine && <Pill tone="accent">your role</Pill>}
                  <span className="flex-1" />
                  {r.denied ? <Pill tone="bad"><Lock /> Refused</Pill>
                    : masks.length ? <Pill tone="violet"><Lock /> {masks.length} withheld</Pill>
                    : <Pill tone="good">Full answer</Pill>}
                </div>
                <p className="mb-0 mt-2 text-[12.5px]">
                  {r.denied ? denies.map((d) => <span key={d.object} className="block"><code>{d.object.split(".").pop()}</code> is {d.tags.map((t) => (meta.tags[t]?.label ?? t).toLowerCase()).join(", ")}</span>)
                    : masks.length ? <>Runs, with <Joined items={masks.map((d) => <code key={d.object}>{d.column}</code>)} /> empty</>
                    : "Runs, with nothing withheld"}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

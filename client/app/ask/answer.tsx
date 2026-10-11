"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp, type AnswerTab } from "@/components/app-context";
import { DataTable } from "@/components/data-table";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Btn, Card, Empty, Joined, Lock, NodeRef, Notice, NoticeList, Pill, Sev, Spinner, SqlBlock, SysBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtStamp, plural } from "@/lib/format";
import type { Answer, Comparison, Role } from "@/lib/types";

/* An answer and everything attached to it: how the SQL came about, what was withheld from this role, what
   might make the numbers wrong, and four tabs (result, SQL, lineage, what the policy decides for every role).
   Every way of asking on the Ask page shows its answer with it: a typed question, the filter form, a query from
   the SQL editor. `busy` says what is on its way: a question for the model to write, or a query that is running. */
export function AnswerPanel({ a, busy }: { a: Answer | null; busy: "ask" | "run" | null }) {
  const { tab, setTab, setMode, meta, role, person } = useApp();
  if (busy === "ask") return <Card pad><Spinner /> &nbsp;Writing the query…</Card>;
  if (!a) return busy ? <Card pad><Spinner /> &nbsp;Running as {person}…</Card> : null;

  if (!a.sql && !a.error) {  // no key, the model could not be reached, or it declined: nothing was run
    return (
      <Card pad>
        <div className="text-[16px] font-[650]">{a.question}</div>
        <p className="mt-1.5 text-ink-2">{a.explanation || "No answer."}</p>
        {a.model_error && <p className="text-[12.5px] text-ink-3">Model error: {a.model_error}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn size="sm" onClick={() => setMode("filter")}>Use Filter</Btn>
          <Btn size="sm" onClick={() => setMode("sql")}>Write SQL</Btn>
        </div>
      </Card>
    );
  }
  if (!a.sql) {  // there is no query to show: the request failed, or what was picked could not be made into one
    return (
      <>
        {busy && <div className="mb-2 text-[12.5px] text-ink-2"><Spinner /> Running as {person}…</div>}
        <Card pad><Notice kind="bad" icon="×"><b>Nothing was run.</b> {a.error}</Notice></Card>
      </>
    );
  }

  // the card names the role the answer was run as: the server reads it from the account on every request
  const ran = meta.roles[a.role ?? role] ?? meta.roles[role];
  const systems = [...new Set((a.context?.feeds ?? []).map((f) => f.system))];
  const count = !a.denied && !a.error && a.row_count !== undefined ? ` · ${a.row_count}${a.truncated ? "+" : ""}` : "";
  const tabs: [AnswerTab, string][] = [["result", `Result${count}`], ["sql", "SQL"], ["lineage", "Lineage"], ["roles", "Compare roles"]];

  return (
    <>
      {busy && <div className="mb-2 text-[12.5px] text-ink-2"><Spinner /> Running as {person}…</div>}
      <Card>
        <div className="border-b border-line px-[18px] pb-3 pt-4">
          <div className="mb-1.5 text-[17px] font-[650] tracking-[-.01em]">{a.question || "SQL query"}</div>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {a.mode === "filter" ? <Pill tone="good">Built from your filters</Pill> : a.mode === "model" ? <Pill tone="accent">SQL written by {a.model}</Pill> : <Pill>Your SQL</Pill>}
            <span className="text-ink-2">as <b>{person}</b>, {ran.name}</span>
            {systems.length > 0 && <span className="text-ink-2">· reads <Joined sep=" " items={systems.map((s) => <SysBadge key={s} system={s} />)} /></span>}
            {a.elapsed_ms !== undefined && <span className="text-ink-3">· {a.elapsed_ms} ms</span>}
          </div>
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
          {tab === "sql" && <SqlTab a={a} />}
          {tab === "lineage" && <LineageTab a={a} />}
          {tab === "roles" && <CompareTab a={a} />}
        </div>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ notices */
/* What the policy did to this query. The client enforces nothing: it reports the decisions the server made. */
function PolicyNotices({ a, ran, person }: { a: Answer; ran: Role; person: string }) {
  const denies = (a.decisions ?? []).filter((d) => d.action === "deny");
  const masks = (a.decisions ?? []).filter((d) => d.action === "mask");
  return (
    <>
      {denies.length > 0 && (
        <Notice kind="bad" icon={<Lock />}>
          <b>{person} cannot run this.</b> The {ran.name} role is not allowed to see:
          <NoticeList>{denies.map((d) => <li key={d.object}><code>{d.object}</code> is {d.reason}.</li>)}</NoticeList>
        </Notice>
      )}
      {masks.length > 0 && (
        <Notice kind="policy" icon={<Lock />}>
          <b>{masks.length} {plural(masks.length, "column")} withheld from {person}</b>, so {masks.length === 1 ? "it comes" : "they come"} back empty{a.row_count === 0 ? " and a filter on them matches nothing" : ""}.
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
  if (a.denied) return <Empty>Nothing to show. <b>Compare roles</b> shows who can run this.</Empty>;
  if (a.error) return <Empty>{a.mode === "sql" ? "Fix the query above and run it again." : <>Open the <b>SQL</b> tab to fix it and run it again.</>}</Empty>;
  if (!a.rows?.length) return <Empty>No rows.</Empty>;
  const traceable = a.traceable ?? [];
  return (
    <>
      <DataTable columns={a.columns ?? []} rows={a.rows} masked={a.masked_columns} traceable={traceable} />
      <p className="mx-0.5 mb-0 mt-2 text-[12.5px] text-ink-3">
        {traceable.length > 0 && "Click an underlined key to see its source rows. "}
        {a.truncated && "Showing the first 500 rows."}
      </p>
    </>
  );
}

/* What ran, to read. Changing it is the other half of the page: the button carries it to the SQL editor. */
function SqlTab({ a }: { a: Answer }) {
  const { editSql } = useApp();
  const tables = a.tables ?? [];
  return (
    <>
      <SqlBlock sql={a.sql ?? ""} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {a.mode !== "sql" && <Btn size="sm" onClick={() => editSql(a.sql ?? "")}>Open in Write SQL</Btn>}
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
        What the policy decides for each role. Only your own role&apos;s answer is run.
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

"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp, type AskMode } from "@/components/app-context";
import { Btn, Card, Pill } from "@/components/ui";
import { AnswerPanel } from "./answer";
import { FilterForm } from "./filter-form";

const EXAMPLE = "Which sites have open safety cases, low drug supply and overdue payments?";
const EXAMPLE_SQL = "SELECT site_key, site_name, n_active, open_safety_cases\nFROM gold.site_360\nORDER BY open_safety_cases DESC";
const MODES: [AskMode, string][] = [["ask", "Ask a question"], ["filter", "Filter"], ["sql", "Write SQL"]];

/* The Ask page has three ways to ask, and each keeps its own answer. "Ask a question" takes plain English, which
   a language model writes into SQL, so it needs a Gemini key. "Filter" is a form: a site, a subject, a category
   of data and limits on its fields, from which the server writes the query by rule. "Write SQL" takes the query
   itself. Only the first involves a language model: with no key to reach it, its tab is grayed out and cannot be
   opened, and a line under the tabs says why and where to add a key. */
export function AskView() {
  const { person, roleName, modelKey, mode, setMode, answer, asking, filterAnswer, filtering, sqlAnswer, running, ask, askFromLink, filterFromLink } = useApp();
  const params = useSearchParams();
  const linked = params.get("q"), linkedFilter = params.get("filter"), linkTab = params.get("tab"), linkTrace = params.get("trace");
  const [q, setQ] = useState(linked ?? answer?.question ?? "");

  // deep link: /ask?q=...&tab=lineage&trace=site_key:S718 reproduces an answer, so it can be shared. /ask?filter=... does the same for the filter form
  useEffect(() => {
    if (linked) askFromLink(linked, { tab: linkTab, trace: linkTrace });
    else if (linkedFilter) filterFromLink(linkedFilter, { tab: linkTab, trace: linkTrace });
  }, [linked, linkedFilter, linkTab, linkTrace, askFromLink, filterFromLink]);

  const pick = (question: string) => { setQ(question); ask(question); };

  return (
    <>
      <Card className="px-[22px] pb-[18px] pt-[22px]">
        <h1 className="text-[24px]">Ask one question across every trial system</h1>
        <p className="text-ink-2">
          EDC, CTMS, IRT, the safety database and the finance ledger each use their own ids for the same sites and subjects.
          Concord has already matched them, so a question that used to mean five extracts and a week of spreadsheets is one query.
          You are asking as <b>{person}</b>, {roleName}.
        </p>
        <div role="tablist" aria-label="How to ask" className="mt-3.5 inline-flex gap-0.5 rounded-[9px] bg-surface-2 p-[3px]">
          {MODES.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
              disabled={id === "ask" && !modelKey} title={id === "ask" && !modelKey ? "Needs a Gemini API key" : undefined}
              className={`rounded-[7px] px-3.5 py-1.5 font-semibold disabled:cursor-default disabled:opacity-55 ${mode === id ? "bg-surface text-accent-ink shadow-card" : "text-ink-2 enabled:hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
        {!modelKey && (
          <p className="mb-0 mt-2 text-[12.5px] text-ink-3">
            <b>Ask a question</b> is off: it needs a Gemini API key, and neither your account nor this server has one.{" "}
            <Link href="/profile">Add yours on your profile</Link> to turn it on. Filter and Write SQL need no key.
          </p>
        )}
        {mode === "ask" ? <QuestionForm q={q} setQ={setQ} pick={pick} /> : mode === "filter" ? <FilterForm /> : <SqlForm />}
      </Card>
      <div className="mt-4">
        {mode === "ask" ? <AnswerPanel a={answer} busy={asking ? "ask" : null} />
          : mode === "filter" ? <AnswerPanel a={filterAnswer} busy={filtering ? "run" : null} />
          : <AnswerPanel a={sqlAnswer} busy={running ? "run" : null} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ ask a question */
function QuestionForm({ q, setQ, pick }: { q: string; setQ: (q: string) => void; pick: (question: string) => void }) {
  return (
    <>
      <form className="mt-3 flex flex-col gap-2.5 sm:flex-row" onSubmit={(e) => { e.preventDefault(); pick(q.trim() || EXAMPLE); }}>
        <input type="text" aria-label="Your question" className="px-3.5 py-3 text-base" placeholder={EXAMPLE} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        <Btn primary size="lg" type="submit">Ask</Btn>
      </form>
      <FreeForm />
    </>
  );
}

/* Whose Gemini key writes the SQL. This form is only ever open when there is one. */
function FreeForm() {
  const { meta, modelKey } = useApp();
  return (
    <p className="mb-0 mt-2.5 text-[12.5px] text-ink-3">
      <Pill tone="good">Free-form asking is on</Pill>{" "}
      Anything you type is written into SQL by {meta.model.id}, using {modelKey === "account" ? "your own Gemini API key" : "this server's Gemini API key"}.
      The SQL it writes is shown with the answer.
    </p>
  );
}

/* ------------------------------------------------------------------ write SQL */
function SqlForm() {
  const { person, roleName, sqlDraft, setSqlDraft, runSql, running } = useApp();
  const run = () => runSql(sqlDraft.trim() || EXAMPLE_SQL);
  return (
    <form className="mt-3" onSubmit={(e) => { e.preventDefault(); run(); }}>
      <textarea aria-label="SQL query" className="min-h-[170px] resize-y whitespace-pre font-mono text-[12.5px] leading-[1.55]" spellCheck={false}
        placeholder={EXAMPLE_SQL} value={sqlDraft} onChange={(e) => setSqlDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }} />
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <Btn primary type="submit" disabled={running}>Run as {person}</Btn>
        <span className="text-[12.5px] text-ink-3">Ctrl or ⌘ + Enter runs it too.</span>
      </div>
      <p className="mb-0 mt-2.5 text-[12.5px] text-ink-3">
        One <code>SELECT</code> over the tables in the <Link href="/catalog">catalog</Link>. No language model is involved: the query goes through
        the same policy check as a question, and runs in a database that holds only what the {roleName} role is granted.
      </p>
    </form>
  );
}

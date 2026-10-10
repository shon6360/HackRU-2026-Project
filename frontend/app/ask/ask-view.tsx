"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Card, Chip } from "@/components/ui";
import { AnswerPanel } from "./answer";

const EXAMPLE = "Which sites have open safety cases, low drug supply and overdue payments?";

export function AskView() {
  const { meta, person, roleName, ask, askFromLink } = useApp();
  const params = useSearchParams();
  const linked = params.get("q"), linkTab = params.get("tab"), linkTrace = params.get("trace");
  const [q, setQ] = useState(linked ?? "");

  // deep link: /ask?q=...&tab=lineage&trace=site_key:S718 reproduces an answer, so it can be shared
  useEffect(() => { if (linked) askFromLink(linked, { tab: linkTab, trace: linkTrace }); }, [linked, linkTab, linkTrace, askFromLink]);

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
        <form className="mb-3 mt-3.5 flex flex-col gap-2.5 sm:flex-row" onSubmit={(e) => { e.preventDefault(); pick(q.trim() || EXAMPLE); }}>
          <input type="text" className="px-3.5 py-3 text-base" placeholder={EXAMPLE} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn primary size="lg" type="submit">Ask</Btn>
        </form>
        <div className="flex flex-wrap gap-2">
          {meta.questions.map((v) => <Chip key={v.id} onClick={() => pick(v.question)}>{v.question}</Chip>)}
        </div>
        <p className="mb-0 mt-3 text-[12.5px] text-ink-3">
          {meta.model.available
            ? `Free-form questions are written into SQL by ${meta.model.id}. The questions above use reviewed SQL.`
            : "No language model key is set, so answers come from the reviewed questions above (closest match). Set GEMINI_API_KEY to ask anything, or write SQL yourself under any answer."}
        </p>
      </Card>
      <div className="mt-4"><AnswerPanel onPick={pick} /></div>
    </>
  );
}

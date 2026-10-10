"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { Answer, Meta } from "@/lib/types";

/* Everything that outlives a single page: the metadata from /api/meta, the role, the current answer on the
   Ask page, the catalog filter and the trace drawer. It lives in the root layout, so it survives navigation. */

export type AnswerTab = "result" | "sql" | "lineage" | "roles";
export type AskLink = { tab?: string | null; trace?: string | null };
const TABS: AnswerTab[] = ["result", "sql", "lineage", "roles"];
const ROLE_KEY = "concord.role";

export type App = {
  meta: Meta;
  role: string;
  person: string;
  roleName: string;
  setRole: (role: string) => void;

  answer: Answer | null;
  pending: "ask" | "sql" | null;
  tab: AnswerTab;
  setTab: (tab: AnswerTab) => void;
  ask: (question: string, link?: AskLink) => void;
  askFromLink: (question: string, link: AskLink) => void;
  runSql: (sql: string, previous: Answer | null) => void;

  catalogFilter: { q: string; layer: string };
  setCatalogFilter: (f: { q: string; layer: string }) => void;

  trace: { column: string; value: string } | null;
  openTrace: (column: string, value: string) => void;
  closeTrace: () => void;
};

const Ctx = createContext<{ app: App | null; error: string | null }>({ app: null, error: null });

/* For the frame, which renders before the metadata has arrived. */
export const useAppState = () => useContext(Ctx);

/* For pages: they are only rendered once the metadata is in. */
export function useApp(): App {
  const { app } = useContext(Ctx);
  if (!app) throw new Error("useApp() was called before /api/meta loaded");
  return app;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRoleState] = useState("clinops");
  const [answer, setAnswerState] = useState<Answer | null>(null);
  const [pending, setPending] = useState<"ask" | "sql" | null>(null);
  const [tab, setTab] = useState<AnswerTab>("result");
  const [catalogFilter, setCatalogFilter] = useState({ q: "", layer: "all" });
  const [trace, setTrace] = useState<{ column: string; value: string } | null>(null);

  // the callbacks below are stable, so they read the latest role and answer through refs
  const roleRef = useRef(role);
  const answerRef = useRef<Answer | null>(null);
  const lastAsked = useRef<string | null>(null);
  const seq = useRef(0);  // only the most recent request may write the answer

  const setAnswer = useCallback((a: Answer | null) => { answerRef.current = a; setAnswerState(a); }, []);

  useEffect(() => {
    api<Meta>("/api/meta").then((m) => {
      let saved: string | null = null;
      try { saved = localStorage.getItem(ROLE_KEY); } catch { /* storage unavailable */ }
      if (saved && m.roles[saved]) { roleRef.current = saved; setRoleState(saved); }
      setMeta(m);
    }, (e: Error) => setError(e.message));
  }, []);

  const openTrace = useCallback((column: string, value: string) => setTrace({ column, value }), []);
  const closeTrace = useCallback(() => setTrace(null), []);

  const runSqlAs = useCallback(async (sql: string, previous: Answer | null, asRole: string) => {
    const id = ++seq.current;
    setPending("sql");
    let res: Answer;
    try { res = await api<Answer>("/api/sql", { sql, role: asRole }); } catch (e) { res = { sql, error: (e as Error).message }; }
    if (id !== seq.current) return;
    setAnswer({ ...res, question: previous?.question, explanation: previous?.explanation, mode: previous?.edited ? "sql" : previous?.mode || "sql",
      matched_question: previous?.matched_question, note: previous?.note, model: previous?.model, edited: previous?.edited });
    setPending(null);
  }, [setAnswer]);

  const runSql = useCallback((sql: string, previous: Answer | null) => { void runSqlAs(sql, previous, roleRef.current); }, [runSqlAs]);

  const ask = useCallback(async (question: string, link?: AskLink) => {
    lastAsked.current = question;
    // the address bar always holds a link that reproduces the answer, so it can be shared
    if (!link) window.history.replaceState(null, "", `${window.location.pathname}?q=${encodeURIComponent(question)}`);
    const id = ++seq.current;
    setPending("ask");
    let res: Answer;
    try { res = await api<Answer>("/api/ask", { question, role: roleRef.current }); } catch (e) { res = { question, error: (e as Error).message, mode: "none" }; }
    if (id !== seq.current) return;
    setAnswer(res);
    setTab(TABS.includes(link?.tab as AnswerTab) ? (link!.tab as AnswerTab) : "result");
    setPending(null);
    if (link?.trace) { const [col, ...val] = link.trace.split(":"); openTrace(col, val.join(":")); }
  }, [setAnswer, openTrace]);

  const askFromLink = useCallback((question: string, link: AskLink) => { if (lastAsked.current !== question) void ask(question, link); }, [ask]);

  // changing role re-runs the current answer's SQL for the new role, so the answer on screen is never another role's
  const setRole = useCallback((next: string) => {
    roleRef.current = next;
    setRoleState(next);
    try { localStorage.setItem(ROLE_KEY, next); } catch { /* ignore */ }
    const a = answerRef.current;
    if (a?.sql) void runSqlAs(a.sql, a, next);
  }, [runSqlAs]);

  const app = useMemo<App | null>(() => meta && {
    meta, role, person: meta.roles[role].person, roleName: meta.roles[role].name, setRole,
    answer, pending, tab, setTab, ask: (q, link) => { void ask(q, link); }, askFromLink, runSql,
    catalogFilter, setCatalogFilter, trace, openTrace, closeTrace,
  }, [meta, role, setRole, answer, pending, tab, ask, askFromLink, runSql, catalogFilter, trace, openTrace, closeTrace]);

  return <Ctx.Provider value={useMemo(() => ({ app, error }), [app, error])}>{children}</Ctx.Provider>;
}

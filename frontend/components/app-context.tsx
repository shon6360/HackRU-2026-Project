"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, SIGNED_OUT } from "@/lib/api";
import type { Account, Answer, Meta } from "@/lib/types";

/* Everything that outlives a single page: who is signed in, the metadata from /api/meta, the current answer
   on the Ask page, the catalog filter and the trace drawer. It lives in the root layout, so it survives
   navigation. All of it is dropped when the session ends, so one account never sees another's answer. */

export type AnswerTab = "result" | "sql" | "lineage" | "roles";
export type AskLink = { tab?: string | null; trace?: string | null };
const TABS: AnswerTab[] = ["result", "sql", "lineage", "roles"];
const NO_FILTER = { q: "", layer: "all" };

export type App = {
  meta: Meta;
  user: Account;
  role: string;      // the account's role. For display: the server takes the role from the session, not from here
  person: string;    // the account's name
  roleName: string;
  canManageAccounts: boolean;  // accounts and roles
  setUser: (user: Account) => void;
  refresh: () => Promise<void>;  // load the account and the metadata again, after a role was changed
  signOut: () => void;

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

type State = { app: App | null; error: string | null; signedOut: boolean; signIn: (username: string, password: string) => Promise<void> };

const Ctx = createContext<State>({ app: null, error: null, signedOut: false, signIn: async () => {} });

/* For the frame, which renders before anyone has signed in. */
export const useAppState = () => useContext(Ctx);

/* For pages: they are only rendered once someone is signed in and the metadata is in. */
export function useApp(): App {
  const { app } = useContext(Ctx);
  if (!app) throw new Error("useApp() was called before sign-in");
  return app;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [user, setUser] = useState<Account | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [pending, setPending] = useState<"ask" | "sql" | null>(null);
  const [tab, setTab] = useState<AnswerTab>("result");
  const [catalogFilter, setCatalogFilter] = useState(NO_FILTER);
  const [trace, setTrace] = useState<{ column: string; value: string } | null>(null);

  const lastAsked = useRef<string | null>(null);
  const seq = useRef(0);  // only the most recent request may write the answer

  /* Who is signed in, then the metadata. With no session both are refused, which fires SIGNED_OUT (lib/api.ts). */
  const load = useCallback(async () => {
    try {
      const [me, m] = await Promise.all([api<Account>("/api/me"), api<Meta>("/api/meta")]);
      setError(null);
      setMeta(m);
      setUser(me);
      setSignedOut(false);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
    }
  }, []);

  /* The session is over: signed out, expired, or the account was deactivated. Drop everything it loaded. */
  const forget = useCallback(() => {
    seq.current++;  // an answer still on its way belongs to the account that asked for it
    lastAsked.current = null;
    setUser(null);
    setSignedOut(true);
    setAnswer(null);
    setPending(null);
    setTab("result");
    setCatalogFilter(NO_FILTER);
    setTrace(null);
  }, []);

  useEffect(() => {
    window.addEventListener(SIGNED_OUT, forget);
    void load();
    return () => window.removeEventListener(SIGNED_OUT, forget);
  }, [load, forget]);

  /* An administrator changes roles and accounts while other people are signed in. Coming back to the tab
     picks up the new names and grants. Only the display waits for this: the server reads the role afresh
     on every request. */
  useEffect(() => {
    if (!user) return;
    const onShow = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [user, load]);

  const signIn = useCallback(async (username: string, password: string) => {
    await api<Account>("/api/login", { username, password });
    await load();
  }, [load]);

  const signOut = useCallback(() => { api("/api/logout", {}).catch(() => { /* signed out here either way */ }).finally(forget); }, [forget]);

  const openTrace = useCallback((column: string, value: string) => setTrace({ column, value }), []);
  const closeTrace = useCallback(() => setTrace(null), []);

  const runSql = useCallback(async (sql: string, previous: Answer | null) => {
    const id = ++seq.current;
    setPending("sql");
    let res: Answer;
    try { res = await api<Answer>("/api/sql", { sql }); } catch (e) { res = { sql, error: (e as Error).message }; }
    if (id !== seq.current) return;
    setAnswer({ ...res, question: previous?.question, explanation: previous?.explanation, mode: previous?.edited ? "sql" : previous?.mode || "sql",
      matched_question: previous?.matched_question, note: previous?.note, model: previous?.model, edited: previous?.edited });
    setPending(null);
  }, []);

  const ask = useCallback(async (question: string, link?: AskLink) => {
    lastAsked.current = question;
    // the address bar always holds a link that reproduces the answer, so it can be shared
    if (!link) window.history.replaceState(null, "", `${window.location.pathname}?q=${encodeURIComponent(question)}`);
    const id = ++seq.current;
    setPending("ask");
    let res: Answer;
    try { res = await api<Answer>("/api/ask", { question }); } catch (e) { res = { question, error: (e as Error).message, mode: "none" }; }
    if (id !== seq.current) return;
    setAnswer(res);
    setTab(TABS.includes(link?.tab as AnswerTab) ? (link!.tab as AnswerTab) : "result");
    setPending(null);
    if (link?.trace) { const [col, ...val] = link.trace.split(":"); openTrace(col, val.join(":")); }
  }, [openTrace]);

  const askFromLink = useCallback((question: string, link: AskLink) => { if (lastAsked.current !== question) void ask(question, link); }, [ask]);

  const app = useMemo<App | null>(() => meta && user && {
    meta, user, role: user.role, person: user.name, roleName: meta.roles[user.role].name,
    canManageAccounts: !!meta.roles[user.role].manages_accounts, setUser, refresh: load, signOut,
    answer, pending, tab, setTab, ask: (q, link) => { void ask(q, link); }, askFromLink, runSql: (sql, previous) => { void runSql(sql, previous); },
    catalogFilter, setCatalogFilter, trace, openTrace, closeTrace,
  }, [meta, user, load, signOut, answer, pending, tab, ask, askFromLink, runSql, catalogFilter, trace, openTrace, closeTrace]);

  return <Ctx.Provider value={useMemo(() => ({ app, error, signedOut, signIn }), [app, error, signedOut, signIn])}>{children}</Ctx.Provider>;
}

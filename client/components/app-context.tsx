"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, SIGNED_OUT } from "@/lib/api";
import type { Account, Answer, FilterSpec, Meta } from "@/lib/types";

/* Everything that outlives a single page: who is signed in, the metadata from /api/meta, the three ways to ask
   on the Ask page (a question, the filter form, the SQL editor, each with its own answer), the catalog filter
   and the trace drawer. It lives in the root layout, so it survives navigation. All of it is dropped when the
   session ends, so one account never sees another's answer. */

export type AskMode = "ask" | "filter" | "sql";
export type AnswerTab = "result" | "sql" | "lineage" | "roles";
export type AskLink = { tab?: string | null; trace?: string | null };
const TABS: AnswerTab[] = ["result", "sql", "lineage", "roles"];
const NO_FILTER = { q: "", layer: "all" };
const NOTHING_PICKED: FilterSpec = { category: "", site_key: null, subject_key: null, conditions: [] };

/* A filter from a link, which anyone may have written by hand: null unless it has the shape of one. */
function readFilter(raw: string): FilterSpec | null {
  try {
    const f = JSON.parse(raw);
    if (typeof f?.category !== "string") return null;
    return { category: f.category, site_key: f.site_key || null, subject_key: f.subject_key || null, conditions: Array.isArray(f.conditions) ? f.conditions : [] };
  } catch { return null; }
}

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
  modelKey: "account" | "server" | null;  // whose Gemini key a free-form question uses. null: free-form asking is not enabled

  mode: AskMode;     // which way of asking is open on the Ask page
  setMode: (mode: AskMode) => void;
  tab: AnswerTab;
  setTab: (tab: AnswerTab) => void;

  answer: Answer | null;  // to the last question
  asking: boolean;
  ask: (question: string, link?: AskLink) => void;
  askFromLink: (question: string, link: AskLink) => void;

  picked: FilterSpec;     // what is in the filter form
  setPicked: (picked: FilterSpec) => void;
  filterAnswer: Answer | null;  // to the last run of the filter form
  filtering: boolean;
  runFilter: (picked: FilterSpec, link?: AskLink) => void;
  filterFromLink: (raw: string, link: AskLink) => void;

  sqlDraft: string;       // what is in the SQL editor
  setSqlDraft: (sql: string) => void;
  sqlAnswer: Answer | null;  // to the last query run from the editor
  running: boolean;
  runSql: (sql: string) => void;
  editSql: (sql: string) => void;  // open the SQL behind an answer in the editor

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
  const [chosenMode, setMode] = useState<AskMode | null>(null);
  const [tab, setTab] = useState<AnswerTab>("result");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState(NOTHING_PICKED);
  const [filterAnswer, setFilterAnswer] = useState<Answer | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [sqlDraft, setSqlDraft] = useState("");
  const [sqlAnswer, setSqlAnswer] = useState<Answer | null>(null);
  const [running, setRunning] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState(NO_FILTER);
  const [trace, setTrace] = useState<{ column: string; value: string } | null>(null);

  const lastAsked = useRef<string | null>(null), lastFiltered = useRef<string | null>(null);
  const askSeq = useRef(0), filterSeq = useRef(0), sqlSeq = useRef(0);  // only the most recent request of each kind may write its answer

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
    askSeq.current++;  // an answer still on its way belongs to the account that asked for it
    filterSeq.current++;
    sqlSeq.current++;
    lastAsked.current = null;
    lastFiltered.current = null;
    setUser(null);
    setSignedOut(true);
    setMode(null);
    setTab("result");
    setAnswer(null);
    setAsking(false);
    setPicked(NOTHING_PICKED);
    setFilterAnswer(null);
    setFiltering(false);
    setSqlDraft("");
    setSqlAnswer(null);
    setRunning(false);
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

  const runSql = useCallback(async (sql: string) => {
    const id = ++sqlSeq.current;
    setSqlDraft(sql);
    setRunning(true);
    let res: Answer;
    try { res = await api<Answer>("/api/sql", { sql }); } catch (e) { res = { sql, error: (e as Error).message, mode: "sql" }; }
    if (id !== sqlSeq.current) return;
    setSqlAnswer(res);
    setTab("result");
    setRunning(false);
  }, []);

  /* The editor starts again from this SQL, so the result of whatever was in it before is put away. */
  const editSql = useCallback((sql: string) => {
    sqlSeq.current++;
    setSqlDraft(sql);
    setSqlAnswer(null);
    setRunning(false);
    setMode("sql");
    window.scrollTo(0, 0);
  }, []);

  const ask = useCallback(async (question: string, link?: AskLink) => {
    lastAsked.current = question;
    // the address bar always holds a link that reproduces the answer, so it can be shared
    if (!link) window.history.replaceState(null, "", `${window.location.pathname}?q=${encodeURIComponent(question)}`);
    const id = ++askSeq.current;
    setMode("ask");
    setAsking(true);
    let res: Answer;
    try { res = await api<Answer>("/api/ask", { question }); } catch (e) { res = { question, error: (e as Error).message, mode: "none" }; }
    if (id !== askSeq.current) return;
    setAnswer(res);
    setTab(TABS.includes(link?.tab as AnswerTab) ? (link!.tab as AnswerTab) : "result");
    setAsking(false);
    if (link?.trace) { const [col, ...val] = link.trace.split(":"); openTrace(col, val.join(":")); }
  }, [openTrace]);

  const askFromLink = useCallback((question: string, link: AskLink) => { if (lastAsked.current !== question) void ask(question, link); }, [ask]);

  /* The filter form, run. Like a question, it leaves a link in the address bar that reproduces the answer. */
  const runFilter = useCallback(async (spec: FilterSpec, link?: AskLink) => {
    const raw = JSON.stringify(spec);
    lastFiltered.current = raw;
    if (!link) window.history.replaceState(null, "", `${window.location.pathname}?filter=${encodeURIComponent(raw)}`);
    const id = ++filterSeq.current;
    setMode("filter");
    setFiltering(true);
    let res: Answer;
    try { res = await api<Answer>("/api/filter", spec); } catch (e) { res = { error: (e as Error).message, mode: "filter" }; }
    if (id !== filterSeq.current) return;
    setFilterAnswer(res);
    setTab(TABS.includes(link?.tab as AnswerTab) ? (link!.tab as AnswerTab) : "result");
    setFiltering(false);
    if (link?.trace) { const [col, ...val] = link.trace.split(":"); openTrace(col, val.join(":")); }
  }, [openTrace]);

  const filterFromLink = useCallback((raw: string, link: AskLink) => {
    if (lastFiltered.current === raw) return;
    const spec = readFilter(raw);
    if (spec) { setPicked(spec); void runFilter(spec, link); }
    lastFiltered.current = raw;  // as the link wrote it, so that coming back to the same link does not run it again
  }, [runFilter]);

  const app = useMemo<App | null>(() => {
    if (!meta || !user) return null;
    const modelKey = user.has_gemini_key ? "account" : meta.model.available ? "server" : null;
    return {
      meta, user, role: user.role, person: user.name, roleName: meta.roles[user.role].name,
      canManageAccounts: !!meta.roles[user.role].manages_accounts, setUser, refresh: load, signOut, modelKey,
      // a typed question needs a Gemini key. With one the page opens on it; without one that way of asking is
      // off, whatever was chosen or linked to, and the page opens on Filter
      mode: modelKey ? chosenMode ?? "ask" : !chosenMode || chosenMode === "ask" ? "filter" : chosenMode, setMode, tab, setTab,
      answer, asking, ask: (q, link) => { void ask(q, link); }, askFromLink,
      picked, setPicked, filterAnswer, filtering, runFilter: (spec, link) => { void runFilter(spec, link); }, filterFromLink,
      sqlDraft, setSqlDraft, sqlAnswer, running, runSql: (sql) => { void runSql(sql); }, editSql,
      catalogFilter, setCatalogFilter, trace, openTrace, closeTrace,
    };
  }, [meta, user, load, signOut, chosenMode, tab, answer, asking, ask, askFromLink, picked, filterAnswer, filtering, runFilter, filterFromLink,
      sqlDraft, sqlAnswer, running, runSql, editSql, catalogFilter, trace, openTrace, closeTrace]);

  return <Ctx.Provider value={useMemo(() => ({ app, error, signedOut, signIn }), [app, error, signedOut, signIn])}>{children}</Ctx.Provider>;
}

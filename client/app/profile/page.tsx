"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Card, Field, Grants, Notice, PageHead, Pill, PlainTable, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import type { Account } from "@/lib/types";

/* Your own account: who you are signed in as, the role the account holds and what that role is granted.
   The name, the password and the Gemini API key are yours to change. The role is not: an administrator sets it. */
export default function ProfilePage() {
  const { user, meta, role, roleName, canManageAccounts } = useApp();
  const details: [string, string][] = [
    ["Username", user.username],
    ["Role", roleName],
    ["Account created", fmtWhen(user.created_at)],
    ["Last sign-in", fmtWhen(user.last_login_at)],
  ];

  return (
    <>
      <PageHead title="Your profile">
        Your account, and what its role lets you see.
      </PageHead>

      <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
        <div className="space-y-3.5">
          <Card pad>
            <h3>Account</h3>
            <NameForm />
            <PlainTable className="mt-3">
              <tbody>
                {details.map(([label, value]) => <tr key={label}><Td className="w-2/5 text-ink-2">{label}</Td><Td>{value}</Td></tr>)}
              </tbody>
            </PlainTable>
          </Card>
          <Card pad>
            <h3>Password</h3>
            <PasswordForm />
          </Card>
        </div>

        <div className="space-y-3.5">
          <Card pad>
            <h3>What you can see</h3>
            <h2>{roleName}</h2>
            <p className="text-[12.5px]">{meta.roles[role].blurb}</p>
            <Grants role={meta.roles[role]} />
            <p className="mb-0 mt-3 text-[12.5px] text-ink-2">
              The <Link href="/access">Access page</Link> lists what each role gets.
              {canManageAccounts && <> Manage accounts on the <Link href="/accounts">Accounts page</Link>.</>}
            </p>
          </Card>
          <Card pad>
            <h3>Gemini API key</h3>
            <GeminiKeyForm />
          </Card>
        </div>
      </div>
    </>
  );
}

function NameForm() {
  const { user, setUser } = useApp();
  const [name, setName] = useState(user.name);
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      const updated = await api<Account>("/api/me", { name }, "PATCH");
      setUser(updated);
      setName(updated.name);
      setState({ saved: true });
    } catch (err) { setState({ error: (err as Error).message }); }
  };

  return (
    <form onSubmit={submit}>
      <Field label="Name">
        <div className="flex gap-2">
          <input type="text" autoComplete="name" maxLength={60} required value={name} onChange={(e) => { setName(e.target.value); setState({}); }} />
          <Btn primary type="submit" disabled={state.busy || !name.trim() || name.trim() === user.name}>Save</Btn>
        </div>
      </Field>
      {state.saved && <Notice kind="good" icon="✓" className="mt-2.5">Your name is changed.</Notice>}
      {state.error && <Notice kind="bad" icon="×" className="mt-2.5">{state.error}</Notice>}
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [state, setState] = useState<{ busy?: boolean; saved?: boolean; error?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setState({ error: "The new password and its repeat are not the same." }); return; }
    setState({ busy: true });
    try {
      await api("/api/me/password", { current, new: next });
      setCurrent(""); setNext(""); setAgain("");
      setState({ saved: true });
    } catch (err) { setState({ error: (err as Error).message }); }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Current password">
        <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" hint="At least 8 characters.">
        <input type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="New password, again">
        <input type="password" autoComplete="new-password" minLength={8} required value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      {state.saved && <Notice kind="good" icon="✓">Your password is changed. Other sessions were signed out.</Notice>}
      {state.error && <Notice kind="bad" icon="×">{state.error}</Notice>}
      <Btn primary type="submit" disabled={state.busy}>Change password</Btn>
    </form>
  );
}

/* Your own key for free-form questions on the Ask page. It goes to the server and is not sent back: the
   account only says whether it has one, so there is nothing here to show, only to replace or remove. */
function GeminiKeyForm() {
  const { user, setUser, modelKey } = useApp();
  const [key, setKey] = useState("");
  const [state, setState] = useState<{ busy?: boolean; saved?: "kept" | "removed"; error?: string }>({});

  const send = async (remove: boolean) => {
    setState({ busy: true });
    try {
      setUser(remove ? await api<Account>("/api/me/gemini-key", undefined, "DELETE") : await api<Account>("/api/me/gemini-key", { key }));
      setKey("");
      setState({ saved: remove ? "removed" : "kept" });
    } catch (err) { setState({ error: (err as Error).message }); }
  };

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send(false); }}>
      <p className="text-[12.5px]">
        {modelKey === "account" ? <><Pill tone="good">Your key is saved</Pill> Your questions use it.</>
          : modelKey === "server" ? <><Pill>Using this server&apos;s key</Pill> Save your own to use it instead.</>
          : <><Pill tone="warn">No key</Pill> Ask a question is off until you add one.</>}
      </p>
      <Field label={user.has_gemini_key ? "Replace your key" : "Your key"}
        hint={<>Create one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>. It is never shown again.</>}>
        <input type="password" autoComplete="off" spellCheck={false} maxLength={200} value={key} onChange={(e) => { setKey(e.target.value); setState({}); }} />
      </Field>
      {state.saved === "kept" && <Notice kind="good" icon="✓">Your key is saved.</Notice>}
      {state.saved === "removed" && <Notice kind="good" icon="✓">Your key is removed.</Notice>}
      {state.error && <Notice kind="bad" icon="×">{state.error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Btn primary type="submit" disabled={state.busy || !key.trim()}>Save key</Btn>
        {user.has_gemini_key && <Btn danger onClick={() => void send(true)} disabled={state.busy}>Remove key</Btn>}
      </div>
      <p className="mb-0 text-[12.5px] text-ink-3">
        A question is sent to Google with a description of the tables your role can see, including a few sample values.
      </p>
    </form>
  );
}

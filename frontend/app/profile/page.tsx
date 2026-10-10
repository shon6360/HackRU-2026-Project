"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Card, Field, Grants, Notice, PageHead, PlainTable, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import type { Account } from "@/lib/types";

/* Your own account: who you are signed in as, the role the account holds and what that role is granted.
   The name and the password are yours to change. The role is not: an administrator sets it. */
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
        Your account, the role it holds, and what that role lets you see. You can change your name and your password here. Your role is set by an administrator.
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

        <Card pad>
          <h3>What you can see</h3>
          <h2>{roleName}</h2>
          <p className="text-[12.5px]">{meta.roles[role].blurb}</p>
          <Grants role={meta.roles[role]} />
          <p className="mb-0 mt-3 text-[12.5px] text-ink-2">
            A table tagged with something you are not granted does not exist for you, and a column tagged that way comes back empty.
            The <Link href="/access">Access page</Link> lists every tagged table and what each role gets from it.
            {canManageAccounts && <> You create, change and remove accounts on the <Link href="/accounts">Accounts page</Link>.</>}
          </p>
        </Card>
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
      <Field label="Name" hint="Shown at the top right, and on every answer you run.">
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
      {state.saved && <Notice kind="good" icon="✓">Your password is changed. Anywhere else this account was signed in, it has been signed out.</Notice>}
      {state.error && <Notice kind="bad" icon="×">{state.error}</Notice>}
      <Btn primary type="submit" disabled={state.busy}>Change password</Btn>
    </form>
  );
}

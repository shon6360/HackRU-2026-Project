"use client";

import { useState, type FormEvent } from "react";
import { useAppState } from "./app-context";
import { Btn, Card, Field, Notice } from "./ui";

/* Shown in place of every page until someone has signed in. The form proves nothing by itself: the server
   checks the password, and answers every other request with a refusal until it has. */
export function SignIn() {
  const { signIn } = useAppState();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await signIn(username, password); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <Card className="mx-auto mt-6 max-w-[400px] px-[22px] py-[22px] sm:mt-[8vh]">
      <h1>Sign in to Concord</h1>
      <p className="text-ink-2">What you can see depends on the role your account holds.</p>
      <form className="mt-4 space-y-3" onSubmit={submit}>
        <Field label="Username">
          <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <Notice kind="bad" icon="×">{error}</Notice>}
        <Btn primary type="submit" disabled={busy} className="w-full">{busy ? "Signing in…" : "Sign in"}</Btn>
      </form>
    </Card>
  );
}

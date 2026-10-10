"use client";

import { useEffect, useState } from "react";

/* Every request goes to the back end's /api routes on the same origin: the back end serves the built site,
   and `next dev` proxies /api to it. A body makes it a POST. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    throw new Error(typeof detail === "string" ? detail : res.statusText);
  }
  return res.json();
}

/* Fetch for a page. While a new path loads (a role switch, say) the previous data stays on screen. */
export function useApi<T>(path: string): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    api<T>(path).then(
      (data) => { if (live) setState({ data }); },
      (e: Error) => { if (live) setState({ error: e.message }); },
    );
    return () => { live = false; };
  }, [path]);
  return state;
}

"use client";

import { useEffect, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/* Fired on `window` when the server says there is no session any more, whichever request found out. */
export const SIGNED_OUT = "concord:signed-out";

/* Every request goes to /api on the client's own address, and the client passes it on to the Concord server
   (app/api/[...path]/route.ts). The browser never needs the server's address, and the session cookie travels
   with the request. A body makes it a POST unless a method is given. */
export async function api<T>(path: string, body?: unknown, method?: "PATCH" | "DELETE"): Promise<T> {
  const res = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    // a 401 from the sign-in form itself is a wrong password, not a session that ended
    if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(typeof detail === "string" ? detail : res.statusText, res.status);
  }
  return res.json();
}

/* Fetch for a page. While a new path loads the previous data stays on screen. */
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

/* The client's only server-side code. Every /api request the browser makes arrives here and is passed on to
   the Concord server, which may be on another computer. The browser only ever talks to the client's own
   address, so the session cookie stays HttpOnly and SameSite=Strict and the server needs no cross-origin
   rules. Nothing is decided here: the server checks the session and the role on every request. */

const DEFAULT_SERVER = "http://127.0.0.1:8040";

/* Read on every request, not at build time: pointing the client at another server takes a restart, not a rebuild. */
function serverAddress(): string {
  const set = (process.env.CONCORD_SERVER ?? "").trim().replace(/\/+$/, "");
  if (!set) return DEFAULT_SERVER;
  return /^https?:\/\//i.test(set) ? set : `http://${set}`;
}

async function forward(request: Request): Promise<Response> {
  const server = serverAddress();
  const { pathname, search } = new URL(request.url);
  const headers = new Headers();
  for (const name of ["cookie", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let answer: Response;
  try {
    answer = await fetch(server + pathname + search, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { detail: `No Concord server answered at ${server}. Check that it is running, and that CONCORD_SERVER in the client's .env file is its address.` },
      { status: 502 },
    );
  }
  // fetch has already decoded the body, so the headers that described its encoding and length no longer hold
  const passed = new Headers(answer.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) passed.delete(name);
  return new Response(answer.body, { status: answer.status, headers: passed });
}

export { forward as GET, forward as POST, forward as PATCH, forward as DELETE };

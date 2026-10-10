# Front end

A Next.js (App Router, TypeScript) and Tailwind CSS app. `npm run build` exports it as plain files
into `out/`, and the back end serves that folder (`backend/server.py`, `server.WEB`), so at run
time there is still one server and no Node process. Everything the app shows comes from the back
end's `/api/...` routes, listed in `backend/CLAUDE.md`. It makes no other requests.

This is Next.js 16. Its conventions differ from older versions: read `AGENTS.md` here, and the
guides it points to under `node_modules/next/dist/docs/`, before changing configuration or routing.

## Commands

Run in `frontend/`. Needs Node.js 20.9 or newer.

```bash
npm install          # once
npm run build        # writes out/, which `python -m backend serve` serves at http://127.0.0.1:8040
npm run dev          # http://localhost:3000 with hot reload; forwards /api to the back end
npm run typecheck    # generates the route types, then tsc
```

- From the repository root, `python -m backend build` does the install (when `node_modules/` is
  missing) and the build, after rebuilding the warehouse.
- `npm run dev` needs the back end running. It forwards `/api` to `http://127.0.0.1:8040`;
  set `CONCORD_API` to point it elsewhere.
- A change shows on port 8040 only after `npm run build`. The running server picks the new files
  up without a restart, unless `out/` did not exist when it started.
- There is no front-end test and no linter. `npm run build` type-checks.
- `out/`, `.next/` and `node_modules/` are gitignored. `package-lock.json` is committed.

## Why a static export

`next.config.ts` returns two configurations. For `next build` it sets `output: "export"` and
`trailingSlash: true`, so each page is `out/<page>/index.html`, which is the layout FastAPI's
static file handler serves with no routing rules. For `next dev` it sets a rewrite that proxies
`/api`. The consequences:

- Nothing that needs a Node server: no server actions, route handlers that read the request,
  rewrites or redirects in production, and no Cache Components (the build refuses it with
  `output: "export"`).
- No dynamic route segments, because the table names are only known from the API. One table is
  `/catalog?table=<schema.name>`, not `/catalog/<schema.name>`.
- Every page fetches in the browser. Nothing is fetched at build time, so the build does not need
  the back end or the warehouse.

## Layout

```
app/
  layout.tsx          the frame: AppProvider and Shell around every page
  page.tsx            / : redirects to /ask, and turns old #/... links into the new ones
  globals.css         Tailwind import, colour tokens, theme, defaults for bare elements
  ask/                page.tsx, ask-view.tsx (the form), answer.tsx (the answer card and its four tabs)
  catalog/            page.tsx, catalog-view.tsx (the list and search), dataset-view.tsx (one table)
  lineage/ crosswalk/ quality/ access/    one page.tsx each
  profile/            page.tsx: your own account, what your role is granted, change your name and password
  accounts/           page.tsx: every account, and the form that adds, changes and removes one (administrators)
  roles/              page.tsx: every role, and the form that adds, changes and removes one (administrators)
components/
  app-context.tsx     state that outlives a page: who is signed in, meta, the current answer, catalog filter, trace
  shell.tsx           top bar (nav, feed dots, account menu), <main> or the sign-in form, the trace drawer
  sign-in.tsx         the sign-in form, shown in place of every page until someone is signed in
  ui.tsx              Pill, TagPill, Notice, Card, Btn, Field, Grants, PlainTable/Th/Td, TraceLink, Lock, ...
  data-table.tsx      every result grid, with masked and traceable cells
  lineage-graph.tsx   the lineage graph as inline SVG, and its legend
  trace-drawer.tsx    where a key comes from: crosswalk matches and source rows
lib/
  api.ts              api(path, body, method), the useApi(path) hook, and the SIGNED_OUT event
  types.ts            the shapes the API returns
  format.ts           fmtCell, fmtInt, LAYERS, SYSTEMS, tableHref
  graph.ts            layoutGraph: one column per layer, extra columns where a layer depends on itself
```

Pages are client components. `ask/page.tsx` and `catalog/page.tsx` are thin server components
that wrap the view in `<Suspense>`, which a page that calls `useSearchParams()` must have or the
build fails.

`AppProvider` loads `/api/me` and `/api/meta` together. `Shell` renders a page only once both have
arrived, so pages call `useApp()` and can rely on `user` and `meta` being there. Until then it
shows the sign-in form in the page's place, at the same address, so a deep link opens the page it
names as soon as the person is in. The answer on the Ask page and the catalog filter live in the
provider, which is why they are still there when you come back to the page.

`api()` fires the `SIGNED_OUT` event on `window` whenever the server answers 401 (the session
expired, or the account was deactivated or removed), and the provider's `forget()` then drops
everything the session loaded: the account, the answer, the trace, the catalog filter. Signing
out goes the same way. One account's answer is never left on screen for the next.

## Rules

- **The UI does not enforce anything.** It only displays the `decisions`, `denied`, `masked` and
  `hidden` fields the server returns. The databases the server queries are the access control.
- **Show what is withheld, never hide it silently.** A refused query, a masked column, a withheld
  table and a hidden finding each get the `Lock` icon and the reason from the API. This is a
  judging criterion, not decoration.
- **The role is never sent.** The server takes it from the session cookie, which the browser
  attaches by itself and scripts cannot read. `app.role` is the account's role as last loaded
  and is for display only. Nothing about the session is kept in `localStorage`.
- **Nobody sees another role's rows.** There is no role switcher: to see what another role gets
  you sign in to an account that holds it. The Compare roles tab asks `/api/compare`, which
  returns only what the policy decides for each role. The answer card names the role the answer
  was run as (`answer.role`), which the server reports.
- **The Accounts and Roles tabs are a convenience.** They are shown when the account's role has
  `manages_accounts`, and `/accounts` and `/roles` show a refusal to anyone else, but it is the
  server that refuses the routes behind them. Forms send only the fields that changed, and show
  the server's error message as it is.
- **Roles are data.** Never write a role id or a role count into a component: take them from
  `meta.roles`, which an administrator can add to at any time. The Roles page shows what is in
  `meta.roles` and calls `refresh()` after a save, which loads the account and the metadata
  again. Other people's tabs pick a change up when they come back to the tab (`visibilitychange`
  in `app-context.tsx`). That only affects what is displayed: the server reads the role's grants
  on every request.
- **No `dangerouslySetInnerHTML`.** The data includes free text from source files and SQL written
  by a model. Rendered as JSX children it is escaped by React; keep it that way.
- **Deep links reproduce an answer:** `/ask?q=<question>&tab=<result|sql|lineage|roles>&trace=<column>:<value>`
  (served as `/ask/?...`). `docs/DEMO.md` relies on them. Links in the old form, `#/ask?q=...`
  and `#/catalog/<table>`, are redirected by `app/page.tsx`; do not remove that.
- `LAYERS` and `SYSTEMS` in `lib/format.ts` repeat what the back end knows. A new layer or source
  system must be added there too.

## Styling

Utility classes in the components; there is no stylesheet besides `app/globals.css`.

- **Colours are tokens.** `globals.css` defines them as custom properties on `:root`, redefines
  them under `prefers-color-scheme: dark`, and maps them into the Tailwind theme (`bg-surface`,
  `text-ink-2`, `border-line`, `text-accent-ink`, `bg-warn-soft`, ...). Tailwind's default palette
  is switched off, so `bg-red-500` does not exist, and no `dark:` variants are needed. Check a
  change in both schemes.
- **Class names must be written out in full.** Tailwind finds classes by scanning the source, so
  `` `text-${tone}` `` produces nothing. Anything chosen by a value from the API is looked up in a
  map in `components/ui.tsx`: `TAG_TONE` (policy tags), `LAYER_TONE`, `SEV_TONE` (rule severity),
  `CONF_TONE` (crosswalk status), `PILL_TONE`, `NOTICE_TONE`. A new value needs a new entry. The
  graph and legend use `var(--layer-<layer>)` inline, so a new layer also needs that property.
- **Do not put two classes for the same property on one element** (for example a default and an
  override passed through `className`): which one wins depends on their order in the generated
  CSS, not in the attribute. Components take a prop for the variant instead (`Card flat`,
  `Btn size`, `Th num`).
- Breakpoints are redefined: `sm` from 641px, `md` from 981px, `xl` from 1321px. Styles are
  written phone-first. Wide tables scroll inside their own wrapper.
- Sizes are in pixels to match the 14px base (`text-[12.5px]`, `px-[18px]`). `text-sm` and friends
  also set a line height, which is usually not wanted here.
- Defaults for bare elements (`h1` to `h3`, `p`, `a`, `code`, text inputs) are in the base layer
  of `globals.css`; a utility class overrides them.

## Formatting conventions in fmtCell

Driven by column name and type: `*_usd` as dollars, integers with thousands separators except
`*_row` and names containing `number`, booleans as Yes / No, NULL as an em dash. Naming a new
gold column to fit gets it formatted for free.

# Front end

Three files, served as-is by the back end (`backend/server.py`): `index.html` at `/`, the rest
under `/static/`. Everything the app shows comes from the back end's `/api/...` routes, which are
listed in `backend/CLAUDE.md`; the front end imports nothing and reads no files. No
framework, no bundler, no npm, no external requests. Keep it that way: the app has to run from
a clean clone with `pip install` alone, and offline.

To see a change, reload the browser. There is nothing to build and no front-end test.

## How app.js is organized

- A hash router (`route()`): `#/ask`, `#/catalog`, `#/catalog/<fqn>`, `#/lineage`,
  `#/crosswalk`, `#/quality`, `#/access`. Each page is a `viewX()` function that fetches from
  `/api/...` and sets `$("#main").innerHTML` from template strings, then wires event listeners.
- One `state` object: `meta` (from `/api/meta`, loaded once at start), `role`, `answer`, `tab`,
  `compare`, `catalogFilter`.
- Helpers: `$`, `$$`, `esc`, `api(path, body)` (POST when a body is given), `dataTable`,
  `renderGraph`, `tagPill`, `layerPill`, `sysBadge`, `fmtCell`.
- `renderGraph` lays out and draws the lineage graph as inline SVG, by hand: one column per
  layer (extra columns where a layer depends on itself), click to highlight upstream and
  downstream, click again to open the table in the catalog.
- The trace drawer (`openTrace`) is shared by every page through `wireTrace(el)`, which binds any
  `.trace-link` element.

## Rules

- **Escape everything.** All HTML is built by string interpolation, and the data includes
  free text from source files and SQL written by a model. Every interpolated value goes
  through `esc()`, in attributes as well as text.
- **The role is sent on every request** as `role` (query string or JSON body). Changing role
  re-runs the current answer's SQL for the new role, or re-renders the page. The role is kept
  in `localStorage` under `concord.role`, inside `try/catch` because storage may be unavailable.
- **Show what is withheld, never hide it silently.** A refused query, a masked column, a
  withheld table and a hidden finding each get a lock icon (`LOCK`) and the reason from the API.
  This is a judging criterion, not decoration.
- **The UI does not enforce anything.** It only displays the `decisions`, `denied` and `masked`
  fields the server returns.
- Deep links reproduce an answer: `#/ask?q=<question>&tab=<result|sql|lineage|roles>&trace=<column>:<value>`.
  `docs/DEMO.md` relies on them. Do not break the format.
- `LAYERS` and `SYSTEMS` at the top of `app.js` repeat what the back end knows. A new layer or
  source system must be added there too (and a `--layer-*` colour in the stylesheet).

## Formatting conventions in fmtCell

Driven by column name and type: `*_usd` as dollars, integers with thousands separators except
`*_row` and names containing `number`, booleans as Yes / No, NULL as an em dash. Naming a new
gold column to fit gets it formatted for free.

## styles.css

- All colours are custom properties on `:root`, redefined under
  `@media (prefers-color-scheme: dark)`. Use the tokens (`--ink`, `--surface`, `--accent`,
  `--warn`, `--bad`, `--good`, `--violet`, `--rose`, and their `-soft` pairs); do not write hex
  values in rules. Check a change in both schemes.
- Per-value classes that must exist for new values: `.pill.tag-<tag>` for each policy tag,
  `.pill.layer-<layer>` and `--layer-<layer>` for each layer, `.sev.<severity>` for each
  rule severity, `.conf.<status>` for each crosswalk status.
- Breakpoints at 1320, 980 and 640 px. Wide tables scroll inside their own wrapper.
- One-off spacing is done with inline `style` attributes in the templates; that is the existing
  practice, not something to refactor.

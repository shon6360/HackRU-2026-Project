/* Concord front end: no build step, no dependencies. Every view is a function that renders into <main>. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOCK = '<svg class="lock" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="5.2" width="8" height="5.8" rx="1.2" fill="currentColor"/><path d="M3.8 5.2V3.6a2.2 2.2 0 0 1 4.4 0v1.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const LAYERS = ["source", "bronze", "silver", "master", "gold"];
const SYSTEMS = ["ctms", "edc", "irt", "safety", "finance"];

const state = { meta: null, role: "clinops", answer: null, tab: "result", catalogFilter: { q: "", layer: "all" } };
try { state.role = localStorage.getItem("concord.role") || "clinops"; } catch (e) { /* storage unavailable */ }

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

/* ------------------------------------------------------------------ small render helpers */
const tagPill = (t) => `<span class="pill tag-${esc(t)}">${LOCK} ${esc(state.meta.tags[t]?.label || t)}</span>`;
const layerPill = (l) => `<span class="pill layer-${esc(l)}">${esc(l)}</span>`;
const sysBadge = (s) => `<span class="sys">${esc(s)}</span>`;
const roleName = (r) => state.meta.roles[r].name;
const person = (r) => state.meta.roles[r].person;
const fmtInt = (n) => Number(n).toLocaleString("en-US");

function fmtCell(value, col) {
  if (value === null || value === undefined) return "—";
  const name = col.name.toLowerCase(), type = col.type.toUpperCase();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (name.endsWith("_usd") || name.startsWith("usd_")) return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (type.includes("INT")) return name.endsWith("_row") || name.includes("number") ? String(value) : fmtInt(value);
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(value);
}

function dataTable(columns, rows, opts = {}) {
  const masked = new Set((opts.masked || []).map((m) => m.toLowerCase()));
  const traceable = new Set((opts.traceable || []).map((m) => m.toLowerCase()));
  const head = columns.map((c) => `<th class="${masked.has(c.name.toLowerCase()) ? "masked" : ""}">${masked.has(c.name.toLowerCase()) ? LOCK + " " : ""}${esc(c.name)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + r.map((v, i) => {
    const c = columns[i], key = c.name.toLowerCase();
    if (masked.has(key) && v === null) return `<td class="masked">${LOCK} withheld</td>`;
    if (v === null || v === undefined) return '<td class="null">—</td>';
    const numeric = typeof v === "number";
    const text = esc(fmtCell(v, c));
    if (traceable.has(key)) return `<td><a class="trace-link" data-trace-col="${esc(c.name)}" data-trace-val="${esc(v)}" title="Trace to source rows">${text}</a></td>`;
    return `<td class="${numeric ? "num" : text.length > 70 ? "long" : ""}">${text}</td>`;
  }).join("") + "</tr>").join("");
  return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ lineage graph (SVG) */
function layoutGraph(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, { ...n, parents: [], children: [] }]));
  for (const [s, d] of graph.edges) { if (byId.has(s) && byId.has(d)) { byId.get(d).parents.push(s); byId.get(s).children.push(d); } }
  // rank inside a layer = longest chain of same-layer parents, so same-layer edges still flow left to right
  const rank = new Map();
  const rankOf = (id) => {
    if (rank.has(id)) return rank.get(id);
    const n = byId.get(id);
    const same = n.parents.filter((p) => byId.get(p).layer === n.layer);
    const r = same.length ? 1 + Math.max(...same.map(rankOf)) : 0;
    rank.set(id, r);
    return r;
  };
  byId.forEach((_, id) => rankOf(id));
  const cols = [];
  for (const layer of LAYERS) {
    const inLayer = [...byId.values()].filter((n) => n.layer === layer);
    const maxRank = Math.max(-1, ...inLayer.map((n) => rank.get(n.id)));
    for (let r = 0; r <= maxRank; r++) cols.push({ layer, first: r === 0, nodes: inLayer.filter((n) => rank.get(n.id) === r) });
  }
  const W = 150, H = 26, GX = 26, GY = 8, TOP = 26;
  const y = new Map();
  cols.forEach((col, ci) => {
    const centre = (n) => { const ps = n.parents.filter((p) => y.has(p)); return ps.length ? ps.reduce((a, p) => a + y.get(p), 0) / ps.length : 1e6; };
    col.nodes.sort((a, b) => centre(a) - centre(b) || a.id.localeCompare(b.id));
    col.nodes.forEach((n, i) => { n.x = ci * (W + GX) + 8; n.y = TOP + i * (H + GY); y.set(n.id, n.y); });
  });
  const height = TOP + Math.max(1, ...cols.map((c) => c.nodes.length)) * (H + GY) + 6;
  return { byId, cols, W, H, GX, width: cols.length * (W + GX) + 8, height };
}

function renderGraph(container, graph, opts = {}) {
  const L = layoutGraph(graph);
  const targets = new Set(graph.targets || []);
  const color = (layer) => `var(--layer-${layer})`;
  let svg = `<svg class="graph" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}">`;
  L.cols.forEach((col, ci) => { if (col.first) svg += `<text class="col-label" x="${ci * (L.W + L.GX) + 8}" y="14">${col.layer === "source" ? "source files" : col.layer}</text>`; });
  for (const [s, d] of graph.edges) {
    const a = L.byId.get(s), b = L.byId.get(d);
    if (!a || !b) continue;
    const x1 = a.x + L.W, y1 = a.y + L.H / 2, x2 = b.x, y2 = b.y + L.H / 2, mx = (x1 + x2) / 2;
    svg += `<path class="edge" data-s="${esc(s)}" data-d="${esc(d)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }
  L.byId.forEach((n) => {
    const label = n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label;
    const cls = ["node", targets.has(n.id) && opts.markTargets ? "target" : "", n.stale ? "stale" : ""].join(" ");
    svg += `<g class="${cls}" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})"><title>${esc(n.id)}${n.rows !== undefined ? ` · ${fmtInt(n.rows)} rows` : ""}${n.stale ? " · STALE feed" : ""}</title>` +
      `<rect class="box" width="${L.W}" height="${L.H}"/><rect class="stripe" width="4" height="${L.H}" rx="2" fill="${color(n.layer)}"/>` +
      `<text x="11" y="17">${esc(label)}</text></g>`;
  });
  svg += "</svg>";
  container.innerHTML = `<div class="graph-wrap">${svg}</div>`;
  // shrink to fit the page when it is close; scroll sideways when it is not
  const el = $("svg", container);
  el.removeAttribute("width"); el.removeAttribute("height");
  el.style.width = "100%"; el.style.maxWidth = L.width + "px"; el.style.minWidth = Math.round(L.width * 0.72) + "px";

  const up = (id, seen = new Set()) => { if (seen.has(id)) return seen; seen.add(id); L.byId.get(id).parents.forEach((p) => up(p, seen)); return seen; };
  const down = (id, seen = new Set()) => { if (seen.has(id)) return seen; seen.add(id); L.byId.get(id).children.forEach((c) => down(c, seen)); return seen; };
  let selected = null;
  const highlight = (id) => {
    const keep = id ? new Set([...up(id), ...down(id)]) : null;
    $$(".node", container).forEach((g) => { g.classList.toggle("dim", !!keep && !keep.has(g.dataset.id)); g.classList.toggle("hi", g.dataset.id === id); });
    $$(".edge", container).forEach((e) => { const on = keep && keep.has(e.dataset.s) && keep.has(e.dataset.d); e.classList.toggle("hi", !!on); e.classList.toggle("dim", !!keep && !on); });
  };
  $$(".node", container).forEach((g) => g.addEventListener("click", () => {
    const id = g.dataset.id;
    if (selected === id) { if (!id.startsWith("feeds/")) location.hash = "#/catalog/" + id; return; }
    selected = id; highlight(id);
    if (opts.onSelect) opts.onSelect(L.byId.get(id), up(id).size - 1, down(id).size - 1);
  }));
  $(".graph-wrap", container).addEventListener("click", (e) => { if (!e.target.closest(".node")) { selected = null; highlight(null); if (opts.onSelect) opts.onSelect(null); } });
}

const LEGEND = `<div class="legend">${LAYERS.map((l) => `<span><i style="background:var(--layer-${l})"></i>${l === "source" ? "source file" : l}</span>`).join("")}<span class="faint">Click a table to light up everything upstream and downstream; click it again to open it.</span></div>`;

/* ------------------------------------------------------------------ top bar */
function renderChrome() {
  $("#roles").innerHTML = Object.entries(state.meta.roles).map(([id, r]) =>
    `<button class="role-btn ${id === state.role ? "active" : ""}" data-role="${id}" role="radio" aria-checked="${id === state.role}" title="${esc(r.blurb)}"><b>${esc(r.person)}</b><span>${esc(r.name)}</span></button>`).join("");
  $$("#roles .role-btn").forEach((b) => b.addEventListener("click", () => setRole(b.dataset.role)));
  $("#feeds").innerHTML = state.meta.feeds.map((f) =>
    `<span class="feed-dot ${f.is_stale ? "stale" : ""}" title="${esc(f.system_name)} · extracted ${esc(f.extracted_at.replace("T", " "))}${f.is_stale ? " · STALE" : ""}">${esc(f.system)}</span>`).join("");
}

function setRole(role) {
  state.role = role;
  try { localStorage.setItem("concord.role", role); } catch (e) { /* ignore */ }
  renderChrome();
  if (currentPage() === "ask" && state.answer && state.answer.sql) runSql(state.answer.sql, state.answer);
  else route();
}

/* ------------------------------------------------------------------ Ask */
function viewAsk() {
  const m = state.meta;
  $("#main").innerHTML = `
    <div class="card ask-hero">
      <h1>Ask one question across every trial system</h1>
      <p class="muted">EDC, CTMS, IRT, the safety database and the finance ledger each use their own ids for the same sites and subjects.
        Concord has already matched them, so a question that used to mean five extracts and a week of spreadsheets is one query.
        You are asking as <b>${esc(person(state.role))}</b>, ${esc(roleName(state.role))}.</p>
      <form class="ask-form" id="ask-form">
        <input type="text" id="q" placeholder="Which sites have open safety cases, low drug supply and overdue payments?" autocomplete="off">
        <button class="btn primary" type="submit">Ask</button>
      </form>
      <div class="chips">${m.questions.map((q) => `<button class="chip" data-q="${esc(q.question)}">${esc(q.question)}</button>`).join("")}</div>
      <p class="small faint" style="margin:12px 0 0">${m.model.available
        ? `Free-form questions are written into SQL by ${esc(m.model.id)}. The questions above use reviewed SQL.`
        : "No language model key is set, so answers come from the reviewed questions above (closest match). Set ANTHROPIC_API_KEY to ask anything, or write SQL yourself under any answer."}</p>
    </div>
    <div id="answer" style="margin-top:16px"></div>`;
  $("#ask-form").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value.trim() || $("#q").placeholder; $("#q").value = q; ask(q); });
  $$(".chip").forEach((c) => c.addEventListener("click", () => { $("#q").value = c.dataset.q; ask(c.dataset.q); }));
  // deep link: #/ask?q=...&tab=lineage&trace=site_key:S718 reproduces an answer, so it can be shared
  const link = hashParams();
  if (link.get("q") && state.answer?.question !== link.get("q")) { $("#q").value = link.get("q"); ask(link.get("q"), link); }
  else if (state.answer) renderAnswer();
}

function hashParams() { return new URLSearchParams(location.hash.split("?")[1] || ""); }

async function ask(question, link) {
  if (!link) history.replaceState(null, "", "#/ask?q=" + encodeURIComponent(question));
  $("#answer").innerHTML = `<div class="card card-pad"><span class="spinner"></span> &nbsp;Working out which systems hold the answer…</div>`;
  try { state.answer = await api("/api/ask", { question, role: state.role }); }
  catch (e) { state.answer = { question, error: e.message, mode: "none" }; }
  state.tab = link?.get("tab") || "result"; state.compare = null;
  renderAnswer();
  if (link?.get("trace")) { const [col, ...val] = link.get("trace").split(":"); openTrace(col, val.join(":")); }
}

async function runSql(sql, previous) {
  const el = $("#answer");
  if (el) el.insertAdjacentHTML("afterbegin", `<div class="small muted" style="margin-bottom:8px"><span class="spinner"></span> Running as ${esc(person(state.role))}…</div>`);
  let res;
  try { res = await api("/api/sql", { sql, role: state.role }); } catch (e) { res = { sql, error: e.message }; }
  state.answer = { ...res, question: previous?.question, explanation: previous?.explanation, mode: previous?.edited ? "sql" : previous?.mode || "sql",
    matched_question: previous?.matched_question, model: previous?.model, edited: previous?.edited };
  state.compare = null;
  if (currentPage() === "ask") renderAnswer();
}

function policyNotices(a) {
  const out = [];
  const denies = (a.decisions || []).filter((d) => d.action === "deny");
  const masks = (a.decisions || []).filter((d) => d.action === "mask");
  if (denies.length) out.push(`<div class="notice bad"><span class="ico">${LOCK}</span><div><b>${esc(person(state.role))} cannot run this question.</b>
    It needs data the ${esc(roleName(state.role))} role is not allowed to see, so nothing was executed.
    <ul>${denies.map((d) => `<li><code>${esc(d.object)}</code> is ${esc(d.reason)}.</li>`).join("")}</ul></div></div>`);
  if (masks.length) out.push(`<div class="notice policy"><span class="ico">${LOCK}</span><div><b>${masks.length} column${masks.length > 1 ? "s" : ""} withheld from ${esc(person(state.role))}.</b>
    The query ran, but these come back empty for this role${a.row_count === 0 ? ", which is why a filter on them matches nothing" : ""}.
    <ul>${masks.map((d) => `<li><code>${esc(d.object)}</code> is ${esc(d.reason)}.</li>`).join("")}</ul></div></div>`);
  return out.join("");
}

function trustNotices(a) {
  return (a.context?.warnings || []).map((w) => {
    if (w.kind === "stale") return `<div class="notice warn"><span class="ico">!</span><div>${esc(w.text)}</div></div>`;
    const rules = w.rules || [];
    return `<div class="notice warn"><span class="ico">!</span><div>${esc(w.text)} <a href="#/quality">Open the quality page</a>
      <details><summary>Show the ${rules.length} failing rule${rules.length > 1 ? "s" : ""}</summary><ul>${rules.map((r) => `<li>${esc(r.title)}: ${r.n_failed} <span class="sev ${esc(r.severity)}">${esc(r.severity)}</span></li>`).join("")}</ul></details></div></div>`;
  }).join("");
}

function renderAnswer() {
  const a = state.answer, el = $("#answer");
  if (!el || !a) return;
  if (!a.sql && !a.error) {  // nothing matched, or the model declined
    el.innerHTML = `<div class="card card-pad"><div class="q" style="font-weight:650;font-size:16px">${esc(a.question)}</div>
      <p class="muted" style="margin-top:6px">${esc(a.explanation || "No answer.")}</p>
      ${a.model_error ? `<p class="small faint">Model error: ${esc(a.model_error)}</p>` : ""}
      <h3 style="margin-top:14px">Reviewed questions you can ask</h3>
      <div class="chips">${(a.suggestions || []).map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div></div>`;
    $$(".chip", el).forEach((c) => c.addEventListener("click", () => { $("#q").value = c.dataset.q; ask(c.dataset.q); }));
    return;
  }
  const mode = a.mode === "vetted" ? '<span class="pill good">Reviewed query</span>'
    : a.mode === "model" ? `<span class="pill accent">SQL written by ${esc(a.model)}</span>` : '<span class="pill">Your SQL</span>';
  const systems = [...new Set((a.context?.feeds || []).map((f) => f.system))];
  const tabs = [["result", a.denied ? "Result" : `Result${a.row_count !== undefined && !a.error ? ` · ${a.row_count}${a.truncated ? "+" : ""}` : ""}`], ["sql", "SQL"], ["lineage", "Lineage"], ["roles", "Compare roles"]];
  el.innerHTML = `<div class="card">
    <div class="answer-head">
      <div class="q">${esc(a.question || "SQL query")}</div>
      <div class="row small">${mode}
        <span class="muted">as <b>${esc(person(state.role))}</b>, ${esc(roleName(state.role))}</span>
        ${systems.length ? `<span class="muted">· reads ${systems.map(sysBadge).join(" ")}</span>` : ""}
        ${a.elapsed_ms !== undefined ? `<span class="faint">· ${a.elapsed_ms} ms</span>` : ""}</div>
      ${a.matched_question && a.matched_question !== a.question ? `<p class="small muted" style="margin:8px 0 0">Closest reviewed question: “${esc(a.matched_question)}”. ${esc(a.note || "")}</p>` : ""}
      ${a.explanation && a.mode !== "sql" ? `<p style="margin:8px 0 0">${esc(a.explanation)}</p>` : ""}
    </div>
    <div class="answer-body stack">${policyNotices(a)}${a.error ? `<div class="notice bad"><span class="ico">×</span><div><b>The query did not run.</b> ${esc(a.error)}</div></div>` : ""}${a.denied || a.error ? "" : trustNotices(a)}</div>
    <div class="tabs">${tabs.map(([id, label]) => `<button class="tab ${state.tab === id ? "active" : ""}" data-tab="${id}">${esc(label)}</button>`).join("")}</div>
    <div class="tab-panel" id="tab-panel"></div></div>`;
  $$(".tab", el).forEach((t) => t.addEventListener("click", () => { state.tab = t.dataset.tab; renderAnswer(); }));
  renderTab();
}

function renderTab() {
  const a = state.answer, panel = $("#tab-panel");
  if (state.tab === "result") {
    if (a.denied) panel.innerHTML = `<div class="empty">Nothing to show. Switch role at the top right, or open <b>Compare roles</b> to see who can run this.</div>`;
    else if (a.error) panel.innerHTML = `<div class="empty">Fix the query under the <b>SQL</b> tab and run it again.</div>`;
    else if (!a.rows.length) panel.innerHTML = `<div class="empty">The query ran and returned no rows.</div>`;
    else panel.innerHTML = dataTable(a.columns, a.rows, { masked: a.masked_columns, traceable: a.traceable }) +
      `<p class="small faint" style="margin:8px 2px 0">${a.traceable?.length ? `Click any underlined <code>${esc(a.traceable.join("</code>, <code>"))}</code> to see the source rows behind it. ` : ""}${a.truncated ? "Showing the first 500 rows." : ""}</p>`;
    wireTrace(panel);
  } else if (state.tab === "sql") {
    panel.innerHTML = `<p class="small muted">This is exactly what ran. Edit it and run it again: your SQL goes through the same policy check and the same sandboxed, role-specific database.</p>
      <textarea class="sql" id="sql-edit" spellcheck="false">${esc(a.sql || "")}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary small" id="sql-run">Run as ${esc(person(state.role))}</button>
      <span class="small faint">Tables used: ${(a.tables || []).map((t) => `<a href="#/catalog/${esc(t)}"><code>${esc(t)}</code></a>`).join(", ") || "none"}</span></div>`;
    $("#sql-run").addEventListener("click", () => runSql($("#sql-edit").value, { ...a, edited: true, question: a.question }));
  } else if (state.tab === "lineage") {
    if (!a.context) { panel.innerHTML = `<div class="empty">No lineage: the query did not parse.</div>`; return; }
    panel.innerHTML = `<p class="small muted">Every table and source file this answer was built from. ${a.context.feeds.map((f) =>
      `${sysBadge(f.system)} extracted ${esc(f.extracted_at.slice(0, 16).replace("T", " "))}${f.is_stale ? ' <span class="pill warn">stale</span>' : ""}`).join(" · ")}</p>${LEGEND}<div id="answer-graph"></div>`;
    renderGraph($("#answer-graph"), a.context.graph, { markTargets: true });
  } else if (state.tab === "roles") {
    panel.innerHTML = `<p class="small muted">The same SQL, run for each role against that role's own database.</p><div class="compare" id="compare"><span class="spinner"></span></div>`;
    compareRoles();
  }
}

async function compareRoles() {
  const a = state.answer;
  if (!state.compare) state.compare = await Promise.all(Object.keys(state.meta.roles).map((r) => api("/api/sql", { sql: a.sql, role: r }).catch((e) => ({ role: r, error: e.message }))));
  const box = $("#compare");
  if (!box) return;
  box.innerHTML = state.compare.map((r) => {
    const role = state.meta.roles[r.role];
    const masks = (r.decisions || []).filter((d) => d.action === "mask");
    const denies = (r.decisions || []).filter((d) => d.action === "deny");
    let verdict, body;
    if (r.error && !r.denied) { verdict = '<span class="pill bad">Error</span>'; body = esc(r.error); }
    else if (r.denied) { verdict = `<span class="pill bad">${LOCK} Refused</span>`; body = denies.map((d) => `<code>${esc(d.object.split(".").pop())}</code> is ${esc(d.tags.map((t) => state.meta.tags[t].label.toLowerCase()).join(", "))}`).join("<br>"); }
    else if (masks.length) { verdict = `<span class="pill tag-unblinded">${LOCK} ${masks.length} withheld</span>`; body = `${r.row_count} row${r.row_count === 1 ? "" : "s"}, with ${masks.map((d) => `<code>${esc(d.column)}</code>`).join(", ")} empty`; }
    else { verdict = '<span class="pill good">Full answer</span>'; body = `${r.row_count} row${r.row_count === 1 ? "" : "s"}`; }
    return `<div class="card card-pad"><div class="row"><h4>${esc(role.person)}</h4><span class="spacer"></span>${verdict}</div>
      <div class="small muted">${esc(role.name)}</div><p class="small" style="margin:8px 0 10px">${body}</p>
      <button class="btn small" data-role="${esc(r.role)}">View as ${esc(role.person)}</button></div>`;
  }).join("");
  $$("button[data-role]", box).forEach((b) => b.addEventListener("click", () => { state.tab = "result"; setRole(b.dataset.role); }));
}

/* ------------------------------------------------------------------ trace drawer */
function wireTrace(el) {
  $$(".trace-link", el).forEach((a) => a.addEventListener("click", () => openTrace(a.dataset.traceCol, a.dataset.traceVal)));
}
function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; }
$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

function confBadge(x) { return `<span class="conf ${esc(x.status)}">${x.status === "unresolved" ? "unresolved" : Number(x.confidence).toFixed(2)}</span>`; }

async function openTrace(column, value) {
  $("#drawer").hidden = false; $("#scrim").hidden = false;
  $("#drawer-title").innerHTML = `Where does <code>${esc(value)}</code> come from?`;
  const body = $("#drawer-body");
  body.innerHTML = '<span class="spinner"></span>';
  let t;
  try { t = await api(`/api/trace?role=${state.role}&column=${encodeURIComponent(column)}&value=${encodeURIComponent(value)}`); }
  catch (e) { body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; return; }
  if (t.error) { body.innerHTML = `<div class="notice bad">${esc(t.error)}</div>`; return; }
  let html = `<p class="muted">Seen as ${esc(person(state.role))}, ${esc(roleName(state.role))}. Raw rows are shown exactly as the source system exported them.</p>`;
  if (t.crosswalk) {
    html += `<h3>How each system's id was matched to <code>${esc(value)}</code></h3>`;
    if (t.crosswalk.denied) html += `<div class="notice policy"><span class="ico">${LOCK}</span><div>The crosswalk is ${esc(t.crosswalk.denied)}.</div></div>`;
    else html += `<div class="card"><table class="plain"><thead><tr><th>System</th><th>Its id</th><th>Match</th><th>Evidence</th></tr></thead><tbody>${t.crosswalk.rows.map((x) =>
      `<tr><td>${sysBadge(x.system)}</td><td><code>${esc(x.native_id)}</code>${x.native_label && x.native_label !== x.native_id && x.method !== "id_pattern" ? `<div class="small faint">${esc(x.native_label)}</div>` : ""}</td>
       <td class="nowrap">${esc(x.method)} ${confBadge(x)}${x.status === "review" ? '<div class="small" style="color:var(--warn)">queued for a steward</div>' : ""}</td><td class="small muted">${esc(x.evidence)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  html += `<h3 style="margin-top:20px">Source rows</h3>`;
  if (!t.sources.length) html += `<p class="muted">No source rows found.</p>`;
  for (const s of t.sources) {
    html += `<div class="src-block"><div class="row"><a href="#/catalog/${esc(s.dataset)}"><code>${esc(s.dataset)}</code></a>${s.system ? sysBadge(s.system) : ""}
      ${s.total ? `<span class="small muted">${fmtInt(s.total)} row${s.total === 1 ? "" : "s"}${s.rows && s.total > s.rows.length ? `, first ${s.rows.length} shown` : ""}</span>` : ""}</div>`;
    if (s.denied) html += `<div class="notice policy" style="margin-top:6px"><span class="ico">${LOCK}</span><div>Withheld: ${esc(s.denied)}.</div></div>`;
    else if (s.rows) {
      const cols = s.columns.map((c) => ({ name: c === "_src_row" ? "row #" : c, type: c === "_src_row" ? "ROWNO" : "VARCHAR" }));
      html += `<div class="path" style="margin:4px 0 6px">${esc(s.file)} &rarr; ${esc(s.bronze)}</div>` + dataTable(cols, s.rows, { masked: s.masked });
    }
    html += `</div>`;
  }
  body.innerHTML = html;
  $$("a[href^='#/catalog']", body).forEach((a) => a.addEventListener("click", closeDrawer));
}

/* ------------------------------------------------------------------ Catalog */
async function viewCatalog() {
  const { datasets } = await api(`/api/catalog?role=${state.role}`);
  const f = state.catalogFilter;
  $("#main").innerHTML = `<div class="page-head"><h1>Data catalog</h1>
    <p>Every table in the platform, from raw export to query-ready, with what it means, who owns it, how fresh it is and who may see it.
    Metadata is visible to everyone; the data itself follows the access policy.</p></div>
    <div class="filters"><input type="text" id="cat-q" placeholder="Search tables and columns: overdue, onset, kit, site_key…" value="${esc(f.q)}">
      <div class="seg" id="cat-layer">${["all", "gold", "master", "silver", "bronze"].map((l) => `<button class="${f.layer === l ? "active" : ""}" data-layer="${l}">${l}</button>`).join("")}</div>
      <span class="small faint" id="cat-count"></span></div>
    <div class="ds-list" id="ds-list"></div>`;
  const order = { gold: 0, master: 1, silver: 2, bronze: 3 };
  const draw = () => {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = datasets.map((d) => {
      const name = d.fqn.toLowerCase(), text = `${d.description} ${d.owner} ${d.tags.join(" ")} ${d.standard}`.toLowerCase(), cols = d.column_text.toLowerCase();
      let score = 0;
      for (const t of terms) { const s = (name.includes(t) ? 5 : 0) + (text.includes(t) ? 2 : 0) + (cols.includes(t) ? 1 : 0); if (!s) return null; score += s; }
      const hits = terms.length ? d.column_names.filter((c) => terms.some((t) => c.toLowerCase().includes(t))) : [];
      return { d, score, hits };
    }).filter((x) => x && (f.layer === "all" || x.d.layer === f.layer))
      .sort((a, b) => b.score - a.score || order[a.d.layer] - order[b.d.layer] || a.d.name.localeCompare(b.d.name));
    $("#cat-count").textContent = `${scored.length} of ${datasets.length} tables`;
    $("#ds-list").innerHTML = scored.map(({ d, hits }) => `<a class="card ds-card ${d.access.denied ? "denied" : ""}" href="#/catalog/${esc(d.fqn)}">
      <div class="row"><span class="name"><span class="schema">${esc(d.schema)}.</span>${esc(d.name)}</span><span class="spacer"></span>
        ${d.access.denied ? `<span class="pill bad">${LOCK} withheld from you</span>` : d.access.n_masked ? `<span class="pill tag-unblinded">${LOCK} ${d.access.n_masked} column${d.access.n_masked > 1 ? "s" : ""} masked</span>` : ""}</div>
      <p>${esc(d.description)}</p>
      ${hits.length ? `<div class="small muted" style="margin:-3px 0 7px">Columns: ${hits.slice(0, 5).map((h) => `<code>${esc(h)}</code>`).join(", ")}</div>` : ""}
      <div class="row small">${layerPill(d.layer)} ${d.tags.map(tagPill).join(" ")}
        <span class="muted">${fmtInt(d.row_count)} rows · ${esc(d.owner)}</span><span class="spacer"></span>
        ${d.stale_systems.length ? `<span class="pill warn">stale: ${esc(d.stale_systems.join(", "))}</span>` : ""}
        <span class="pill ${d.fair.passed === d.fair.total ? "good" : ""}" title="FAIR checklist">FAIR ${d.fair.passed}/${d.fair.total}</span></div></a>`).join("")
      || `<div class="empty">Nothing matches.</div>`;
  };
  $("#cat-q").addEventListener("input", (e) => { f.q = e.target.value; draw(); });
  $$("#cat-layer button").forEach((b) => b.addEventListener("click", () => { f.layer = b.dataset.layer; $$("#cat-layer button").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));
  draw();
}

async function viewDataset(fqn) {
  const d = await api(`/api/dataset/${encodeURIComponent(fqn)}?role=${state.role}`);
  const colRows = d.columns.map((c) => `<tr><td><code>${esc(c.name)}</code>${c.masked ? ` <span class="pill tag-unblinded" title="Masked for your role">${LOCK} masked</span>` : ""}</td>
    <td class="small faint nowrap">${esc(c.type)}</td><td>${esc(c.description)} ${c.tags.map(tagPill).join(" ")}</td>
    <td class="num small">${c.null_pct}%</td><td class="num small">${fmtInt(c.n_distinct)}</td>
    <td class="small muted">${c.masked || d.access.denied ? `<span class="faint">${LOCK} withheld</span>` : c.samples.map((s) => `<code>${esc(s)}</code>`).join(", ")}</td></tr>`).join("");
  const link = (id) => id.startsWith("feeds/") ? `<code>${esc(id)}</code>` : `<a href="#/catalog/${esc(id)}"><code>${esc(id)}</code></a>`;
  $("#main").innerHTML = `<div class="page-head"><div class="small"><a href="#/catalog">Catalog</a> / ${esc(d.schema)}</div>
    <h1 class="mono" style="font-size:21px;margin-top:4px">${esc(d.fqn)}</h1>
    <div class="row" style="margin:6px 0 8px">${layerPill(d.layer)} ${d.tags.map(tagPill).join(" ")} ${d.standard ? `<span class="pill">${esc(d.standard)}</span>` : ""}
      ${d.stale_systems.length ? `<span class="pill warn">built on a stale feed: ${esc(d.stale_systems.join(", "))}</span>` : ""}</div>
    <p>${esc(d.description)}</p></div>
    ${d.access.denied ? `<div class="notice bad" style="margin-bottom:14px"><span class="ico">${LOCK}</span><div><b>You can read about this table but not query it.</b> It is ${esc(d.access.reason)}.</div></div>` : ""}
    <div class="grid grid-3">
      <div class="card card-pad"><h3>About</h3><dl class="kv">
        <dt>Owner</dt><dd>${esc(d.owner)}</dd><dt>Steward</dt><dd>${esc(d.steward)}</dd><dt>Grain</dt><dd>${esc(d.grain)}</dd>
        <dt>Rows</dt><dd>${fmtInt(d.row_count)}</dd>
        <dt>Source</dt><dd>${d.source_file ? `<code>${esc(d.source_file)}</code>` : d.upstream_systems.map(sysBadge).join(" ") || "—"}</dd></dl></div>
      <div class="card card-pad"><h3>Freshness</h3>${d.feeds.length ? `<table class="plain">${d.feeds.map((f) => `<tr><td>${sysBadge(f.system)}</td>
        <td class="small">${esc(f.extracted_at.slice(0, 16).replace("T", " "))}</td><td>${f.is_stale ? `<span class="pill warn">${Math.round(f.age_hours / 24)}d old · SLA ${Math.round(f.freshness_sla_hours / 24)}d</span>` : '<span class="pill good">within SLA</span>'}</td></tr>`).join("")}</table>` : '<p class="muted small">Not derived from a feed.</p>'}</div>
      <div class="card card-pad"><h3>FAIR checklist · ${d.fair.passed}/${d.fair.total}</h3><div class="fair">${d.fair_checks.map((c) =>
        `<span class="letter">${c.letter}</span><span>${esc(c.check)}</span><span class="${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "×"}</span>`).join("")}</div></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-pad" style="padding-bottom:6px"><h3>Columns</h3></div>
      <div style="overflow:auto"><table class="plain"><thead><tr><th>Column</th><th>Type</th><th>Meaning</th><th class="num">Null</th><th class="num">Distinct</th><th>Common values</th></tr></thead><tbody>${colRows}</tbody></table></div></div>
    ${d.preview ? `<div class="card card-pad" style="margin-top:14px"><h3>First rows, as ${esc(person(state.role))} sees them</h3>${dataTable(d.preview.columns.map((c) => ({ name: c, type: "" })), d.preview.rows, { masked: Object.keys(d.access.masked), traceable: ["site_key", "subject_key"] })}</div>` : ""}
    <div class="card card-pad" style="margin-top:14px"><h3>Lineage</h3>
      <p class="small muted">Built from ${d.upstream.map(link).join(", ") || "nothing (root)"}${d.downstream.length ? `. Feeds ${d.downstream.map(link).join(", ")}` : ""}.</p>${LEGEND}<div id="ds-graph"></div></div>
    ${d.rules.length ? `<div class="card card-pad" style="margin-top:14px"><h3>Quality rules on this table</h3><table class="plain">${d.rules.map((r) =>
      `<tr><td>${esc(r.title)}</td><td class="small muted">${esc(r.dimension)}</td><td class="nowrap">${r.n_failed ? `<span class="pill bad">${r.n_failed} failing</span>` : '<span class="pill good">passing</span>'}</td></tr>`).join("")}</table>
      <p class="small" style="margin:8px 0 0"><a href="#/quality">Open the quality page</a></p></div>` : ""}
    ${d.sql ? `<div class="card card-pad" style="margin-top:14px"><details class="block" open><summary>How it is built (SQL)</summary><pre class="sql">${esc(d.sql)}</pre></details></div>` : ""}`;
  renderGraph($("#ds-graph"), d.graph, { markTargets: true });
  wireTrace($("#main"));
}

/* ------------------------------------------------------------------ Lineage */
async function viewLineage() {
  const g = await api("/api/lineage");
  $("#main").innerHTML = `<div class="page-head"><h1>Lineage</h1>
    <p>How every table is built, from the files each system exports to the tables people query. The graph is read out of the SQL itself, so it cannot drift from what actually runs.</p></div>
    ${LEGEND}<div id="graph"></div><div id="graph-info" class="small muted" style="margin-top:10px">${g.nodes.length} nodes, ${g.edges.length} edges.</div>`;
  renderGraph($("#graph"), { ...g, targets: [] }, { onSelect: (n, nUp, nDown) => {
    $("#graph-info").innerHTML = n ? `<code>${esc(n.id)}</code> is built from ${nUp} upstream node${nUp === 1 ? "" : "s"} and feeds ${nDown} downstream. ${n.id.startsWith("feeds/") ? "" : `<a href="#/catalog/${esc(n.id)}">Open in the catalog</a>`}` : `${g.nodes.length} nodes, ${g.edges.length} edges.`;
  } });
}

/* ------------------------------------------------------------------ Crosswalk */
async function viewCrosswalk() {
  const x = await api(`/api/crosswalk?role=${state.role}`);
  const cell = (site, sys) => {
    const ids = site.ids.filter((i) => i.system === sys);
    if (!ids.length) return '<td class="null">—</td>';
    return `<td class="cell">${ids.map((i) => `<div title="${esc(i.evidence)}">${esc(i.native_id)}${i.method === "id_pattern" ? "" : confBadge(i)}
      ${i.native_label && i.native_label !== i.native_id && sys !== "ctms" && sys !== "edc" && sys !== "irt" ? `<span class="lbl">${esc(i.native_label)}</span>` : ""}</div>`).join("")}</td>`;
  };
  const review = x.sites.flatMap((s) => s.ids.filter((i) => i.status === "review").map((i) => ({ ...i, site: s })));
  $("#main").innerHTML = `<div class="page-head"><h1>Crosswalk</h1>
    <p>The same site is <code>SITE-0701</code> in CTMS, <code>701</code> in EDC, <code>US701</code> in IRT, a free-text name in the safety database and a vendor's legal name in finance.
    This is the map that lets one question reach all five. Every match records its method, a confidence and the evidence; hover any id to read it.</p></div>
    <div class="grid grid-4">
      <div class="card stat"><div class="v">${x.sites.length}</div><div class="l">sites, each with one master key</div></div>
      <div class="card stat"><div class="v">${x.counts.auto}</div><div class="l">identifiers matched automatically</div></div>
      <div class="card stat"><div class="v" style="color:var(--warn)">${x.counts.review}</div><div class="l">matched, queued for a steward</div></div>
      <div class="card stat"><div class="v" style="color:var(--bad)">${x.counts.unresolved}</div><div class="l">could not be matched</div></div>
    </div>
    <div class="card card-pad" style="margin-top:14px"><h3>What each system calls things</h3><table class="plain">${x.feeds.map((f) =>
      `<tr><td class="nowrap">${sysBadge(f.system)}</td><td>${esc(f.system_name)}</td><td class="small muted">${esc(f.id_conventions)}</td></tr>`).join("")}</table></div>
    <div class="card" style="margin-top:14px"><div class="card-pad" style="padding-bottom:6px"><h3>Sites</h3></div><div style="overflow:auto">
      <table class="plain xw"><thead><tr><th>Master key</th><th>Site</th>${SYSTEMS.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>${x.sites.map((s) =>
        `<tr><td><a class="trace-link" data-trace-col="site_key" data-trace-val="${esc(s.site_key)}">${esc(s.site_key)}</a></td>
         <td>${esc(s.site_name)}<div class="small faint">${esc(s.city)}, ${esc(s.state)} · ${esc(s.pi)}</div></td>${SYSTEMS.map((sys) => cell(s, sys)).join("")}</tr>`).join("")}</tbody></table></div></div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="card card-pad"><h3>Queued for a data steward</h3>${review.length ? review.map((r) => `<div style="margin-bottom:10px">${sysBadge(r.system)} <code>${esc(r.native_id)}</code> ${esc(r.native_label || "")}
        <div class="small">matched to <b>${esc(r.site.site_key)}</b> at ${Number(r.confidence).toFixed(2)}, runner-up ${esc(r.runner_up_site_key)} at ${Number(r.runner_up_confidence).toFixed(2)}</div>
        <div class="small muted">${esc(r.evidence)}</div></div>`).join("") : '<p class="muted">Nothing waiting.</p>'}
        <p class="small faint">Two sites in the same city with near-identical names: the match is used, and flagged wherever it matters, until a person confirms it.</p></div>
      <div class="card card-pad"><h3>Could not be matched</h3>${x.unresolved.map((r) => `<div style="margin-bottom:10px">${sysBadge(r.system)} <code>${esc(r.native_id)}</code> ${r.native_label && r.native_label !== r.native_id ? esc(r.native_label) : ""}
        <div class="small muted">${esc(r.evidence)}</div></div>`).join("") || '<p class="muted">Everything resolved.</p>'}
        <p class="small faint">Unmatched identifiers are never guessed. Their rows stay out of site totals and show up as findings on the Quality page.</p></div>
    </div>
    <div class="card card-pad" style="margin-top:14px"><h3>Subjects</h3>
      ${x.subjects.denied ? `<div class="notice policy" style="margin-bottom:10px"><span class="ico">${LOCK}</span><div>Subject identifiers are ${esc(x.subjects.denied)}. Counts only.</div></div>` : ""}
      <table class="plain"><thead><tr><th>System</th><th>How it is matched</th><th>Status</th><th class="num">Identifiers</th><th>Example</th></tr></thead><tbody>${x.subjects.groups.map((g) =>
        `<tr><td>${sysBadge(g.system)}</td><td>${esc(g.method)}</td><td><span class="conf ${esc(g.status)}">${esc(g.status)}</span></td><td class="num">${fmtInt(g.n)}</td><td>${g.example ? `<code>${esc(g.example)}</code>` : `<span class="faint">${LOCK} withheld</span>`}</td></tr>`).join("")}</tbody></table></div>`;
  wireTrace($("#main"));
}

/* ------------------------------------------------------------------ Quality */
async function viewQuality() {
  const q = await api(`/api/quality?role=${state.role}`);
  const k = q.answer_key;
  const extra = Object.values(k.additional_by_rule);
  $("#main").innerHTML = `<div class="page-head"><h1>Data quality</h1>
    <p>${q.totals.rules} rules run on every build. Each finding names the record, says what is wrong in plain words and points at the file and row it came from.
    The feeds were seeded with a documented set of problems so the rules can be scored against an answer key.</p></div>
    <div class="grid grid-4">
      <div class="card stat"><div class="v" style="color:var(--good)">${k.n_caught}/${k.n_planted}</div><div class="l">planted problems caught</div></div>
      <div class="card stat"><div class="v">${k.n_additional}</div><div class="l">further findings nobody planted</div></div>
      <div class="card stat"><div class="v">${q.totals.findings}</div><div class="l">findings in all, from ${q.totals.rules - q.totals.passing} of ${q.totals.rules} rules</div></div>
      <div class="card stat"><div class="v">${q.feeds.filter((f) => f.is_stale).length}/${q.feeds.length}</div><div class="l">feeds past their freshness SLA</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:14px">
      <div class="card card-pad"><h3>Feed freshness, as of ${esc(state.meta.as_of)}</h3><table class="plain">${q.feeds.map((f) =>
        `<tr><td>${sysBadge(f.system)}</td><td class="small">${esc(f.owner)}</td><td class="small nowrap">${esc(f.extracted_at.slice(0, 16).replace("T", " "))}</td>
         <td>${f.is_stale ? `<span class="pill warn">${Math.round(f.age_hours / 24)} days old · SLA ${Math.round(f.freshness_sla_hours / 24)}d</span>` : `<span class="pill good">${Math.round(f.age_hours)}h old</span>`}</td></tr>`).join("")}</table></div>
      <div class="card card-pad"><h3>By dimension</h3><table class="plain">${q.dimensions.map((d) =>
        `<tr><td>${esc(d.dimension)}</td><td style="width:40%"><div class="bar ${d.passing < d.rules ? "warn" : ""}"><i style="width:${Math.round(100 * d.passing / d.rules)}%"></i></div></td>
         <td class="small muted nowrap">${d.passing}/${d.rules} rules passing</td><td class="num small">${d.findings} finding${d.findings === 1 ? "" : "s"}</td></tr>`).join("")}</table></div>
    </div>
    ${extra.length ? `<div class="notice info" style="margin-top:14px"><span class="ico">i</span><div><b>${k.n_additional} findings beyond the answer key.</b>
      Most are partial onset dates in the real CDISC pilot data; the rest are knock-on effects of a planted problem seen from a second system, and the two look-alike sites queued for a steward.
      <ul>${extra.map((e) => `<li>${e.n} under “${esc(e.title)}”</li>`).join("")}</ul></div></div>` : ""}
    <div class="card" style="margin-top:14px">${q.rules.map((r) => `<details class="rule"${r.n_failed && r.severity === "critical" ? "" : ""}>
      <summary><span class="sev ${esc(r.severity)}">${esc(r.severity)}</span><span>${esc(r.title)}<div class="small faint"><code>${esc(r.dataset)}</code></div></span>
        <span class="small muted">${esc(r.dimension)}</span><span class="small muted num">${fmtInt(r.n_checked)} checked</span>
        <span class="num">${r.n_failed ? `<span class="pill bad">${r.n_failed}</span>` : '<span class="pill good">pass</span>'}</span></summary>
      <div class="body">${r.hidden ? `<div class="notice policy"><span class="ico">${LOCK}</span><div>${r.n_failed} finding${r.n_failed === 1 ? "" : "s"}. The records are ${esc(r.hidden)}.</div></div>`
        : r.failures.length ? `<table class="plain"><thead><tr><th>Record</th><th>What is wrong</th><th>Source</th><th></th></tr></thead><tbody>${r.failures.map((f) =>
          `<tr><td><code>${esc(f.record_key)}</code></td><td>${esc(f.detail)}</td><td class="small muted nowrap">${f.file ? `${esc(f.file)}${f.row ? `, row ${f.row}` : ""}` : esc(f.system || "")}</td>
           <td>${f.planted ? '<span class="pill accent" title="In the answer key">planted</span>' : ""}</td></tr>`).join("")}</tbody></table>` : '<p class="muted small">No failing records.</p>'}
        ${r.sql ? `<details class="block" style="margin-top:8px"><summary class="small muted">Rule SQL</summary><pre class="sql">${esc(r.sql)}</pre></details>` : ""}</div></details>`).join("")}</div>`;
}

/* ------------------------------------------------------------------ Access */
async function viewAccess() {
  const a = await api("/api/access");
  const roles = Object.entries(a.roles), tags = Object.entries(a.tags);
  const outcome = (r) => r.denied ? `<span class="pill bad">${LOCK} withheld</span>` : r.masked.length ? `<span class="pill tag-unblinded" title="${esc(r.masked.join(", "))}">${LOCK} ${r.masked.length} masked</span>` : '<span class="pill good">full</span>';
  $("#main").innerHTML = `<div class="page-head"><h1>Access</h1>
    <p>The policy is three tags and three roles. A table carrying a tag the role lacks does not exist for that role; a column carrying one comes back empty.
    Each role queries its own read-only database that physically contains only what it may see, so the rule holds for hand-written SQL and model-written SQL alike.</p></div>
    <div class="grid grid-3">${roles.map(([id, r]) => `<div class="card card-pad"><div class="row"><h2 style="margin:0">${esc(r.person)}</h2><span class="spacer"></span>${id === state.role ? '<span class="pill accent">you</span>' : `<button class="btn small" data-role="${id}">Switch</button>`}</div>
      <div class="muted">${esc(r.name)}</div><p class="small" style="margin:8px 0 10px">${esc(r.blurb)}</p>
      <table class="plain">${tags.map(([t, meta]) => `<tr><td>${tagPill(t)}</td><td class="num">${r.grants.includes(t) ? '<span class="ok">✓ granted</span>' : '<span class="no">× not granted</span>'}</td></tr>`).join("")}</table></div>`).join("")}</div>
    <div class="card card-pad" style="margin-top:14px"><h3>What the tags mean</h3><table class="plain">${tags.map(([t, meta]) => `<tr><td class="nowrap">${tagPill(t)}</td><td>${esc(meta.description)}</td></tr>`).join("")}</table></div>
    <div class="card" style="margin-top:14px"><div class="card-pad" style="padding-bottom:6px"><h3>Every tagged table, and what each role gets</h3></div><div style="overflow:auto">
      <table class="plain"><thead><tr><th>Table</th><th>Tagged</th>${roles.map(([, r]) => `<th>${esc(r.person)}</th>`).join("")}</tr></thead><tbody>${a.datasets.map((d) =>
        `<tr><td><a href="#/catalog/${esc(d.fqn)}"><code>${esc(d.fqn)}</code></a></td>
         <td>${d.tags.map(tagPill).join(" ")} ${Object.entries(d.column_tags).map(([c, ts]) => `<span class="small muted"><code>${esc(c)}</code> ${ts.map(tagPill).join("")}</span>`).join(" ")}</td>
         ${roles.map(([id]) => `<td>${outcome(d.roles[id])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  $$("button[data-role]").forEach((b) => b.addEventListener("click", () => setRole(b.dataset.role)));
}

/* ------------------------------------------------------------------ router */
function currentPage() { return (location.hash.replace(/^#\//, "").split("?")[0] || "ask").split("/")[0]; }

async function route() {
  const parts = (location.hash.replace(/^#\//, "").split("?")[0] || "ask").split("/");
  const page = parts[0];
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  $("#main").classList.toggle("wide", page === "lineage");
  window.scrollTo(0, 0);
  try {
    if (page === "catalog" && parts[1]) await viewDataset(decodeURIComponent(parts.slice(1).join("/")));
    else if (page === "catalog") await viewCatalog();
    else if (page === "lineage") await viewLineage();
    else if (page === "crosswalk") await viewCrosswalk();
    else if (page === "quality") await viewQuality();
    else if (page === "access") await viewAccess();
    else viewAsk();
  } catch (e) {
    $("#main").innerHTML = `<div class="notice bad"><span class="ico">×</span><div><b>Could not load this page.</b> ${esc(e.message)}</div></div>`;
  }
}

(async function start() {
  try { state.meta = await api("/api/meta"); }
  catch (e) { $("#main").innerHTML = `<div class="notice bad">Concord's API is not responding: ${esc(e.message)}</div>`; return; }
  if (!state.meta.roles[state.role]) state.role = "clinops";
  renderChrome();
  window.addEventListener("hashchange", route);
  route();
})();

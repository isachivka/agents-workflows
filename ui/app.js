import { html, render, useState, useEffect, useCallback } from "./vendor/preact-htm.js";

export const enc = encodeURIComponent;

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || (data.errors || []).join("\n") || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// One SSE connection; live components re-fetch whenever flowd says something changed.
const listeners = new Set();
let version = 0;
new EventSource("/api/stream").onmessage = () => {
  version++;
  for (const fn of listeners) fn(version);
};

export function useData(path, live = true) {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    listeners.add(setTick);
    return () => listeners.delete(setTick);
  }, [live]);
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return api("GET", path).then((data) => setState({ data, error: null }), (error) => setState({ data: null, error }));
  }, [path]);
  useEffect(() => { load(); }, [load, tick]);
  return { ...state, reload: load };
}

function useRoute() {
  const read = () => (location.hash || "#/runs").slice(2).split("/").map(decodeURIComponent);
  const [route, setRoute] = useState(read());
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (...parts) => { location.hash = `#/${parts.map(enc).join("/")}`; };
export const attempt = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { alert(e.message); }
};
export const focus = (sid) => attempt(() => api("POST", `/api/sessions/${enc(sid)}/focus`));
export const isUrl = (v) => /^https?:\/\//.test(String(v));
export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && v !== null));
const ICON = { pending: "·", waiting: "⏳", active: "▶", done: "✓", failed: "✗", skipped: "–" };
const when = (ts) => new Date(ts).toLocaleString();
const sessionLabel = (s) => `${s.workspace} / ${s.name || s.title || s.id.slice(0, 8)}`;

function Loading({ error }) {
  return error ? html`<p class="err">${error.message}</p>` : html`<p class="muted">loading…</p>`;
}

function Runs() {
  const { data, error } = useData("/api/runs?all=1");
  if (!data) return html`<${Loading} error=${error} />`;
  const open = data.filter((r) => r.status !== "done" && r.status !== "stopped");
  const groups = [
    ["Needs you", open.filter((r) => r.needsYou)],
    ["Running", open.filter((r) => !r.needsYou)],
    ["Finished", data.filter((r) => !open.includes(r)).slice(0, 30)],
  ];
  return html`
    <div class="bar"><h1 style="flex:1">Runs</h1><button class="primary" onClick=${() => go("processes")}>Start a process…</button></div>
    ${data.length === 0 && html`<p class="muted">Nothing has run yet. Start one from <a href="#/processes">processes</a>.</p>`}
    ${groups.map(([title, rows]) => rows.length > 0 && html`
      <h2>${title} (${rows.length})</h2>
      <table><tbody>${rows.map((r) => html`<${RunRow} r=${r} />`)}</tbody></table>`)}`;
}

function RunRow({ r }) {
  return html`<tr>
    <td><a href="#/run/${enc(r.id)}">${r.id}</a><div class="muted">it.${r.iteration}</div></td>
    <td><span class="st ${r.status}">${r.status}</span></td>
    <td>
      ${r.current ? html`<b>${r.current}</b> <span class="muted">${r.currentStatus}${r.waitingOn ? ` · ⏳ ${r.waitingOn}` : ""}</span>` : "—"}
      ${r.reason && html`<div class="reason">${r.reason}</div>`}
    </td>
    <td>${Object.entries(r.vars).filter(([, v]) => isUrl(v)).map(([k, v]) => html`<a href=${v} target="_blank" rel="noreferrer">${k}</a> `)}</td>
    <td>${Object.entries(r.roles).map(([role, sid]) => (sid
      ? html`<button class="jump" title=${sid} onClick=${focus(sid)}>${role} ↗</button> `
      : html`<span class="muted">${role}: — </span>`))}</td>
  </tr>`;
}

function Run({ arg: id }) {
  const { data: r, error } = useData(`/api/runs/${enc(id)}`);
  const [sel, setSel] = useState(null);
  if (!r) return html`<${Loading} error=${error} />`;
  const post = (path, body = {}) => attempt(() => api("POST", `/api/runs/${enc(id)}${path}`, body));
  const ask = (path, question) => attempt(async () => {
    const note = prompt(question);
    if (note === null) return;
    await api("POST", `/api/runs/${enc(id)}${path}`, { note });
  });
  const open = r.status !== "done" && r.status !== "stopped";
  const selected = sel || r.current;
  return html`
    <h1>${r.id} <span class="st ${r.status}">${r.status}</span> <span class="muted">iteration ${r.iteration}</span></h1>
    ${r.reason && html`<p class="reason">${r.reason}</p>`}
    ${open && html`<div class="bar">
      ${r.status === "paused" ? html`<button onClick=${post("/resume")}>resume</button>` : html`<button onClick=${post("/pause")}>pause</button>`}
      <button class="danger" onClick=${() => { if (confirm(`Stop ${r.id}?`)) post("/stop")(); }}>stop</button>
    </div>`}
    <ol class="plan">${r.plan.map((e) => html`
      <li class="${e.status} ${e.id === r.current ? "cur" : ""} ${e.detour ? "detour" : ""} ${e.id === selected ? "sel" : ""}" onClick=${() => setSel(e.id)}>
        ${ICON[e.status]} ${e.id}${e.kind === "human" ? " [you]" : ""}${e.waitFor ? ` ⏳ ${e.waitFor}` : ""}<small>${e.role || e.kind}</small>
      </li>`)}</ol>
    ${selected && html`<${EntryPanel} run=${r} id=${selected} post=${post} ask=${ask} open=${open} key=${selected} />`}
    <h2>Roles</h2>
    <${Roles} run=${r} post=${post} open=${open} />
    <h2>Vars</h2>
    ${Object.keys(r.vars).length === 0
      ? html`<p class="muted">none</p>`
      : html`<table><tbody>${Object.entries(r.vars).map(([k, v]) => html`<tr><td>${k}</td><td>${isUrl(v) ? html`<a href=${v} target="_blank" rel="noreferrer">${v}</a>` : v}</td></tr>`)}</tbody></table>`}
    <h2>Events</h2>
    <table>
      <thead><tr><th>when</th><th>type</th><th>step</th><th>outcome</th><th>data</th></tr></thead>
      <tbody>${r.events.map((e) => html`<tr>
        <td class="muted">${when(e.ts)}</td><td>${e.type}</td><td>${e.entry || e.data.entry || ""}</td>
        <td>${e.outcome || ""}</td><td class="muted"><code>${JSON.stringify(e.data).slice(0, 160)}</code></td>
      </tr>`)}</tbody>
    </table>`;
}

function EntryPanel({ run, id, post, ask, open }) {
  const e = run.plan.find((x) => x.id === id);
  const s = run.entries[id] || {};
  const { data: prompt, error } = useData(e && e.kind === "agent" ? `/api/runs/${enc(run.id)}/entries/${enc(id)}/prompt` : null);
  if (!e) return null;
  const path = `/entries/${enc(id)}`;
  const current = id === run.current;
  return html`<section class="panel">
    <h3>${id} <span class="muted">${e.kind}${e.role ? ` · ${e.role}` : ""} · ${s.status || "pending"} · attempts ${s.attempts || 0} · failures ${s.failures || 0}</span></h3>
    ${s.note && html`<p>note: ${s.note}</p>`}
    ${s.evidence && html`<p>evidence: <a href=${s.evidence} target="_blank" rel="noreferrer">${s.evidence}</a></p>`}
    ${s.event && html`<p class="muted">woken by ${s.event.type} ${s.event.outcome || ""}</p><pre>${JSON.stringify(s.event.data, null, 2)}</pre>`}
    ${prompt && html`<pre>${prompt.text}</pre>`}
    ${error && html`<p class="err">${error.message}</p>`}
    ${open && html`<div class="bar">
      ${current && html`
        <button class="primary" onClick=${post(`${path}/done`)}>done</button>
        <button onClick=${ask(`${path}/failed`, "What went wrong?")}>failed</button>
        <button onClick=${ask(`${path}/skip`, "Why skip it?")}>skip</button>
        <button onClick=${post(`${path}/retry`)}>retry</button>`}
      ${!current && html`<button onClick=${post(`${path}/goto`)}>go here</button>`}
    </div>`}
  </section>`;
}

function Roles({ run, post, open }) {
  const { data: sessions } = useData("/api/sessions", false);
  const [pick, setPick] = useState({});
  return html`<table><tbody>${Object.entries(run.roles).map(([role, sid]) => html`<tr>
    <td>${role}</td>
    <td>${sid
      ? html`<code>${sid.slice(0, 8)}</code> <span class="muted">${run.sessions[sid] || "unknown"}</span>`
      : html`<span class="muted">no session — one is spawned on its next step</span>`}</td>
    <td><div class="bar">
      ${sid && html`<button class="jump" onClick=${focus(sid)}>open ↗</button>`}
      ${open && html`
        <button onClick=${post(`/roles/${enc(role)}/respawn`)}>respawn</button>
        <select value=${pick[role] || ""} onChange=${(ev) => setPick({ ...pick, [role]: ev.target.value })}>
          <option value="">rebind to…</option>
          ${(sessions || []).map((x) => html`<option value=${x.id}>${sessionLabel(x)}</option>`)}
        </select>
        <button disabled=${!pick[role]} onClick=${post(`/roles/${enc(role)}/rebind`, { session: pick[role] })}>rebind</button>`}
    </div></td>
  </tr>`)}</tbody></table>`;
}

function Processes() {
  const { data, error } = useData("/api/processes");
  const [name, setName] = useState("");
  if (!data) return html`<${Loading} error=${error} />`;
  return html`
    <div class="bar"><h1 style="flex:1">Processes</h1>
      <input placeholder="new-process-name" value=${name} onInput=${(e) => setName(e.target.value.trim())} />
      <button disabled=${!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick=${() => go("process", name)}>New</button>
    </div>
    <table>
      <thead><tr><th>process</th><th>steps</th><th>triggers</th><th>open runs</th><th></th></tr></thead>
      <tbody>${data.map((p) => html`<tr>
        <td><a href="#/process/${enc(p.name)}">${p.name}</a>${p.repeat ? html` <span class="st">repeat</span>` : ""}
          <div class="muted">${p.description}</div>
          ${p.errors.length > 0 && html`<div class="err">${p.errors.join("\n")}</div>`}</td>
        <td class="muted">${p.entries.map((e) => e.id).join(" → ")}</td>
        <td class="muted">${p.triggers.map((t) => t.cron || t.on).join(", ") || "manual"}</td>
        <td>${p.openRuns.map((rid) => html`<a href="#/run/${enc(rid)}">${rid}</a> `)}</td>
        <td><button class="primary" disabled=${!p.valid} onClick=${() => go("start", p.name)}>Run…</button></td>
      </tr>`)}</tbody>
    </table>`;
}

function StartForm({ arg: name }) {
  const { data: list, error } = useData("/api/processes", false);
  const { data: sessions } = useData("/api/sessions", false);
  const [bind, setBind] = useState({});
  if (!list) return html`<${Loading} error=${error} />`;
  const p = list.find((x) => x.name === name);
  if (!p) return html`<p class="err">no process ${name}</p>`;
  const start = attempt(async () => {
    const r = await api("POST", "/api/runs", { process: name, bind: clean(bind) });
    go("run", r.run);
  });
  return html`
    <h1>Run ${name}</h1>
    <p class="muted">${p.description}</p>
    <div class="grid2">${p.roles.map((role) => html`
      <label>${role}</label>
      <select value=${bind[role] || ""} onChange=${(e) => setBind({ ...bind, [role]: e.target.value })}>
        <option value="">spawn a new session</option>
        ${(sessions || []).map((s) => html`<option value=${s.id}>${sessionLabel(s)}</option>`)}
      </select>`)}</div>
    ${p.roles.length === 0 && html`<p class="muted">No agent roles to bind.</p>`}
    <div class="bar"><button class="primary" onClick=${start}>Start</button><button onClick=${() => history.back()}>Cancel</button></div>`;
}

// Task 13 adds the editors and the plugins page to this map.
const pages = { runs: Runs, run: Run, processes: Processes, start: StartForm };
const TAB = { run: "runs", start: "processes", process: "processes", step: "steps" };

function App() {
  const [page, arg] = useRoute();
  const Page = pages[page] || Runs;
  const tab = TAB[page] || page;
  return html`
    <header><b>flows</b>
      <nav>${["runs", "processes", "steps", "plugins"].map((p) => html`<a href="#/${p}" class=${tab === p ? "on" : ""}>${p}</a>`)}</nav>
    </header>
    <main><${Page} arg=${arg} key=${`${page}/${arg || ""}`} /></main>`;
}

render(html`<${App} />`, document.getElementById("app"));

import { html, render, useState, useEffect } from "./vendor/preact-htm.js";
import { api, useData, useNow, useRoute, go, attempt, focus, isUrl, enc, clean, sessionLabel, Icon, Err } from "./lib.js";
import { t, tn, setLang, getLang, defaultLang, LANGS, describeRun, situation, currentEntry, entryPhrase, eventPhrase,
  eventSentence, entryBranch, progress, waitingSince, processFacts, duration, ago, clock, moment, runLabel } from "./text.js";
import { ProcessEditor, Steps, StepEditor } from "./editors.js";

const LANG_KEY = "flows.lang";
function savedLang() {
  try { return localStorage.getItem(LANG_KEY) || defaultLang(navigator.language); } catch { return defaultLang(navigator.language); }
}
setLang(savedLang());

const Loading = ({ error }) => (error ? html`<p class="err-box">${error.message}</p>` : html`<p class="muted">${t("loading")}</p>`);
const Pill = ({ tone, children }) => html`<span class="pill ${tone}">${children}</span>`;
const isOpen = (r) => r.status !== "done" && r.status !== "stopped";

// the old screens, until Tasks 6-8 replace them
const ICON = { pending: "·", waiting: "⏳", active: "▶", done: "✓", failed: "✗", skipped: "–" };
const when = (ts) => new Date(ts).toLocaleString();

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
      ${r.current ? html`<b>${r.current}</b> <span class="muted">${r.currentStatus}${r.waitingOn ? ` · ⏳ ${r.waitingOn}` : ""}${r.agentWait ? ` · waiting: ${r.agentWait.note}` : ""}</span>` : "—"}
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
        ${e.id === r.current && r.agentWait ? "⏸" : ICON[e.status]} ${e.id}${e.kind === "human" ? " [you]" : ""}${e.waitFor ? ` ⏳ ${e.waitFor}` : ""}<small>${e.role || e.kind}</small>
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
  const { data: prompt, error } = useData(e && (e.kind === "agent" || e.kind === "human") ? `/api/runs/${enc(run.id)}/entries/${enc(id)}/prompt` : null);
  if (!e) return null;
  const path = `/entries/${enc(id)}`;
  const current = id === run.current;
  return html`<section class="panel">
    <h3>${id} <span class="muted">${e.kind}${e.role ? ` · ${e.role}` : ""} · ${s.status || "pending"} · attempts ${s.attempts || 0} · failures ${s.failures || 0}</span></h3>
    ${s.wait && html`<p>⏸ waiting since ${new Date(s.wait.since).toLocaleString()}: ${s.wait.note}${s.wait.human ? " — on a human" : ""}</p>`}
    ${s.note && html`<p>note: ${s.note}</p>`}
    ${s.evidence && html`<p>evidence: ${isUrl(s.evidence) ? html`<a href=${s.evidence} target="_blank" rel="noreferrer">${s.evidence}</a>` : s.evidence}</p>`}
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
      <button disabled=${!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick=${() => go("process", name, "edit")}>New</button>
    </div>
    <table>
      <thead><tr><th>process</th><th>steps</th><th>triggers</th><th>open runs</th><th></th></tr></thead>
      <tbody>${data.map((p) => html`<tr>
        <td><a href="#/process/${enc(p.name)}">${p.name}</a>${p.repeat ? html` <span class="st">repeat</span>` : ""}
          <div class="muted">${p.description}</div>
          ${p.errors.length > 0 && html`<div class="err">${p.errors.join("\n")}</div>`}
          ${(p.triggerErrors || []).length > 0 && html`<div class="err">${p.triggerErrors.map((e) => `trigger: ${e}`).join("\n")}</div>`}</td>
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

const LangSwitch = ({ lang, onLang }) => html`<div class="lang" role="group" aria-label=${t("lang.label")}>
  ${LANGS.map((l) => html`<button type="button" class=${l === lang ? "on" : ""} aria-pressed=${l === lang} onClick=${() => onLang(l)}>${l.toUpperCase()}</button>`)}
</div>`;

function Settings({ lang, onLang }) {
  const { data, error } = useData("/api/plugins");
  const [err, setErr] = useState(null);
  const restart = attempt(async () => {
    if (!confirm(t("set.restartConfirm"))) return;
    await api("POST", "/api/restart");
    setTimeout(() => location.reload(), 2500);
  }, setErr);
  return html`
    <section class="head"><div><h1>${t("set.title")}</h1></div></section>
    <section><h2>${t("set.language")}</h2><${LangSwitch} lang=${lang} onLang=${onLang} /></section>
    <section><h2>${t("set.steps")}</h2><p><a href="#/steps">${t("set.allSteps")}</a></p></section>
    <section><h2>${t("set.plugins")}</h2>
      ${!data ? html`<${Loading} error=${error} />` : html`
        <p class="muted small">${t("set.coreEvents")}: ${data.core.join(", ")}. ${t("set.adhoc")}</p>
        <div class="scroll"><table class="tech">
          <thead><tr><th>${t("set.plugin")}</th><th>${t("set.events")}</th><th>${t("set.actions")}</th><th>${t("set.watching")}</th><th>${t("set.lastError")}</th></tr></thead>
          <tbody>${data.plugins.map((p) => html`<tr>
            <td>${p.name}<div class="muted"><code>${p.source}</code></div></td>
            <td>${p.events.map((e) => `${p.name}.${e}`).join(", ")}</td>
            <td>${p.actions.join(", ") || "—"}</td>
            <td>${p.watches.length === 0 ? "—" : p.watches.map((w) => html`<div>${w.run === null
              ? html`${t("set.trigger")} · ${(w.processes || []).map((n, i) => html`${i ? ", " : ""}<a href="#/process/${enc(n)}">${n}</a>`)} <span class="muted">${w.type}</span>`
              : html`<a href="#/run/${enc(w.run)}">${runLabel(w.run)}</a> · ${w.entry}`} ${w.error && html`<span class="err">${w.error}</span>`}</div>`)}</td>
            <td class="err">${p.lastError || "—"}</td>
          </tr>`)}</tbody>
        </table></div>`}
    </section>
    <section><h2>${t("set.service")}</h2><${Err} msg=${err} /><div class="acts"><button class="btn" onClick=${restart}>${t("set.restart")}</button></div></section>`;
}

const MARK = html`<svg class="mark" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="7" fill="currentColor" />
  <path d="M8.5 22.5C8.5 13 23.5 19 23.5 9.5" fill="none" stroke="var(--bg)" stroke-width="2.6" stroke-linecap="round" />
  <circle cx="8.5" cy="22.5" r="3.2" fill="var(--bg)" /><circle cx="23.5" cy="9.5" r="3.2" fill="#8aa6ff" /></svg>`;

const PAGES = { runs: Runs, run: Run, processes: Processes, process: ProcessEditor, start: StartForm, steps: Steps, step: StepEditor, settings: Settings, plugins: Settings };
const TAB = { runs: "now", run: "now", processes: "processes", process: "processes", start: "processes", settings: "settings", plugins: "settings", steps: "settings", step: "settings" };
const NAV = [["now", "#/runs"], ["processes", "#/processes"], ["settings", "#/settings"]];

function pageTitle(page, arg) {
  if (page === "run" && arg) return runLabel(arg);
  if ((page === "process" || page === "start" || page === "step") && arg) return arg;
  return t(`nav.${TAB[page] || "now"}`);
}

function App() {
  const [page, arg, sub] = useRoute();
  const [lang, setLangState] = useState(getLang());
  const { data: openRuns } = useData("/api/runs");
  const waiting = (openRuns || []).filter((r) => r.needsYou).length;
  const tab = TAB[page] || "now";
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = waiting > 0 ? t("title.waiting", { n: waiting }) : t("title.page", { page: pageTitle(page, arg) });
    const icon = document.getElementById("favicon");
    if (icon) icon.href = waiting > 0 ? "/icons/favicon-attention.svg" : "/icons/favicon.svg";
  });
  const onLang = (l) => {
    setLang(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* private window: the choice lasts this visit */ }
    setLangState(l);
  };
  const Page = PAGES[page] || PAGES.runs;
  // the language is not in the key: switching it re-renders the page without dropping an editor's edits
  return html`
    <header class="top"><div class="wrap topin">
      <a class="logo" href="#/runs">${MARK}<span>flows</span></a>
      <nav class="nav" aria-label=${t("nav.label")}>${NAV.map(([k, href]) => html`<a href=${href} class=${tab === k ? "on" : ""}
        aria-current=${tab === k ? "page" : undefined}>${t(`nav.${k}`)}${k === "now" && waiting > 0 ? html`<span class="count">${waiting}</span>` : ""}</a>`)}</nav>
      <${LangSwitch} lang=${lang} onLang=${onLang} />
    </div></header>
    <main class="wrap page"><${Page} arg=${arg} sub=${sub} lang=${lang} onLang=${onLang} key=${`${page}/${arg || ""}/${sub || ""}`} /></main>`;
}

render(html`<${App} />`, document.getElementById("app"));

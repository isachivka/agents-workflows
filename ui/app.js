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
      <button disabled=${!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick=${() => go("process", name)}>New</button>
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

// selected on the option itself: the lists arrive after the <select> first renders
const options = (items, value) => items.map((x) => html`<option value=${x} selected=${x === value}>${x}</option>`);
const NEW_PROCESS = { description: "", cwd: "~", repeat: false, roles: { agent: { spawn: "claude --dangerously-skip-permissions" } }, steps: [] };
const SESSION_ACTIONS = ["clear", "compact", "type"];

function ProcessEditor({ arg: name }) {
  const { data, error, reload } = useData(`/api/processes/${enc(name)}`, false);
  const { data: stepList } = useData("/api/steps", false);
  const { data: plugins } = useData("/api/plugins", false);
  const isNew = Boolean(error && error.status === 404);
  const [obj, setObj] = useState(null);
  const [text, setText] = useState("");
  const [mtime, setMtime] = useState(null);
  const [tab, setTab] = useState("form");
  const [errors, setErrors] = useState([]);
  useEffect(() => {
    if (data) { setObj(data.object || {}); setText(data.text); setMtime(data.mtime); setErrors(data.errors); }
    else if (isNew) { setObj(structuredClone(NEW_PROCESS)); setText(""); setMtime(null); setErrors([]); }
  }, [data, isNew]);
  if (error && !isNew) return html`<${Loading} error=${error} />`;
  if (!obj) return html`<${Loading} />`;
  const eventTypes = plugins ? [...plugins.core, ...plugins.plugins.flatMap((p) => p.events.map((e) => `${p.name}.${e}`))] : [];
  const actions = plugins ? plugins.plugins.flatMap((p) => p.actions.map((a) => `${p.name}.${a}`)) : [];
  const save = async () => {
    try {
      const r = await api("PUT", `/api/processes/${enc(name)}`, tab === "yaml" ? { text, mtime } : { object: obj, mtime });
      setMtime(r.mtime);
      setErrors([]);
      await reload();
    } catch (e) {
      if (e.status === 409) {
        if (confirm("The file changed on disk. Reload it and drop your edits?")) await reload();
        return;
      }
      if (e.data && e.data.errors) setErrors(e.data.errors);
      else alert(e.message);
    }
  };
  const remove = attempt(async () => {
    if (!confirm(`Delete process ${name}?`)) return;
    await api("DELETE", `/api/processes/${enc(name)}?mtime=${mtime}`);
    go("processes");
  });
  return html`
    <div class="bar"><h1 style="flex:1">${name}${isNew ? " (new)" : ""}</h1>
      <span class="tabs">
        <button class=${tab === "form" ? "on" : ""} onClick=${() => setTab("form")}>form</button>
        <button class=${tab === "yaml" ? "on" : ""} onClick=${() => setTab("yaml")}>YAML</button>
      </span>
      <button class="primary" onClick=${save}>Save</button>
      ${!isNew && html`<button class="danger" onClick=${remove}>Delete</button>`}
    </div>
    ${errors.length > 0 && html`<pre class="err">${errors.join("\n")}</pre>`}
    ${tab === "yaml"
      ? html`<p class="muted">Saving from this tab writes the text as it is, comments included. Saving from the form rewrites the file. The two tabs do not share unsaved edits.</p>
             <textarea rows="30" value=${text} onInput=${(e) => setText(e.target.value)} />`
      : html`<${ProcessForm} obj=${obj} set=${setObj} stepIds=${(stepList || []).map((s) => s.id)} eventTypes=${eventTypes} actions=${actions} />`}`;
}

function ProcessForm({ obj, set, stepIds, eventTypes, actions }) {
  const upd = (patch) => set(clean({ ...obj, ...patch }));
  const roles = obj.roles || {};
  const roleNames = Object.keys(roles);
  const triggers = obj.triggers || [];
  const setTrigger = (i, t) => upd({ triggers: triggers.map((x, j) => (j === i ? t : x)) });
  return html`
    <div class="grid2">
      <label>description</label><input value=${obj.description || ""} onInput=${(e) => upd({ description: e.target.value })} />
      <label>cwd</label><input value=${obj.cwd || ""} onInput=${(e) => upd({ cwd: e.target.value })} />
      <label>repeat</label><input type="checkbox" checked=${Boolean(obj.repeat)} onChange=${(e) => upd({ repeat: e.target.checked })} />
      <label>max_runs</label><input type="number" min="1" value=${obj.max_runs || 1} onInput=${(e) => upd({ max_runs: Number(e.target.value) > 1 ? Number(e.target.value) : undefined })} />
    </div>
    <h2>Roles</h2>
    ${roleNames.map((r) => html`<div class="bar">
      <b style="width:110px">${r}</b>
      <input style="flex:2" placeholder="spawn command" value=${roles[r].spawn || ""}
        onInput=${(e) => upd({ roles: { ...roles, [r]: { ...roles[r], spawn: e.target.value } } })} />
      <input style="flex:1" placeholder="cwd (optional, {{vars.x}} allowed)" value=${roles[r].cwd || ""}
        onInput=${(e) => upd({ roles: { ...roles, [r]: clean({ ...roles[r], cwd: e.target.value }) } })} />
      <button class="danger" onClick=${() => { const next = { ...roles }; delete next[r]; upd({ roles: next }); }}>×</button>
    </div>`)}
    <button onClick=${() => { const r = prompt("Role name"); if (r) upd({ roles: { ...roles, [r]: { spawn: "claude --dangerously-skip-permissions" } } }); }}>+ role</button>
    <h2>Triggers</h2>
    ${triggers.map((t, i) => html`<div class="bar">
      <select value=${t.cron !== undefined ? "cron" : "on"} onChange=${(e) => setTrigger(i, e.target.value === "cron" ? { cron: "0 10 * * 1-5" } : { on: eventTypes[0] || "" })}>
        <option value="cron">cron</option><option value="on">on event</option>
      </select>
      ${t.cron !== undefined
        ? html`<input value=${t.cron} onInput=${(e) => setTrigger(i, { cron: e.target.value })} />`
        : html`<input list="event-types" style="width:150px" value=${t.on} onChange=${(e) => setTrigger(i, { ...t, on: e.target.value.trim() })} />
               <input placeholder='where, JSON: {"process": "x"}' value=${t.where ? JSON.stringify(t.where) : ""}
                 onChange=${(e) => {
                   try { setTrigger(i, clean({ ...t, where: e.target.value ? JSON.parse(e.target.value) : undefined })); }
                   catch { alert("where must be a JSON object"); }
                 }} />
               <input placeholder='with, JSON: {"base":"main"}' value=${t.with ? JSON.stringify(t.with) : ""}
                 onChange=${(e) => {
                   try { setTrigger(i, clean({ ...t, with: e.target.value ? JSON.parse(e.target.value) : undefined })); }
                   catch { alert("with must be a JSON object"); }
                 }} />`}
      <button class="danger" onClick=${() => upd({ triggers: triggers.filter((_, j) => j !== i) })}>×</button>
    </div>`)}
    <button onClick=${() => upd({ triggers: [...triggers, { cron: "0 10 * * 1-5" }] })}>+ trigger</button>
    <h2>Steps</h2>
    <${EntryCards} entries=${obj.steps || []} onChange=${(steps) => upd({ steps })} roles=${roleNames} stepIds=${stepIds} eventTypes=${eventTypes} actions=${actions} />`;
}

const entryId = (e) => e.id || e.step || e.do || (typeof e.wait_for === "string" ? e.wait_for : e.wait_for && e.wait_for.on) || "?";
const kindOf = (e) => (e.step !== undefined ? "step" : e.do !== undefined ? "do" : "wait");

function EntryCards({ entries, onChange, roles, stepIds, eventTypes, actions }) {
  const [drag, setDrag] = useState(null);
  const ids = entries.map(entryId);
  const put = (i, patch) => onChange(entries.map((e, j) => (j === i ? clean({ ...e, ...patch }) : e)));
  const move = (from, to) => {
    const next = [...entries];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  const changeKind = (i, k) => {
    const e = entries[i];
    const keep = { id: e.id, wait_for: e.wait_for, on_fail: e.on_fail, retries: e.retries, timeout: e.timeout, after: e.after, detour: e.detour };
    const next = k === "step" ? { ...keep, step: stepIds[0], role: roles[0] || "human" }
      : k === "do" ? { ...keep, do: "clear", role: roles[0] }
      : { ...keep, wait_for: e.wait_for || eventTypes[0] };
    onChange(entries.map((x, j) => (j === i ? clean(next) : x)));
  };
  return html`
    ${entries.map((e, i) => {
      const kind = kindOf(e);
      const waitObject = e.wait_for && typeof e.wait_for === "object";
      const failGoto = e.on_fail && typeof e.on_fail === "object" ? e.on_fail.goto : "";
      return html`<div class="card ${drag === i ? "drag" : ""}"
          onDragOver=${(ev) => ev.preventDefault()}
          onDrop=${() => { if (drag !== null && drag !== i) move(drag, i); setDrag(null); }}>
        <span class="grip" draggable="true" title="drag to reorder" onDragStart=${() => setDrag(i)} onDragEnd=${() => setDrag(null)}>⠿</span>
        <div class="fields">
          <b>${i + 1}. ${ids[i]}</b>
          <label>kind <select value=${kind} onChange=${(ev) => changeKind(i, ev.target.value)}>
            <option value="step">step</option><option value="do">action</option><option value="wait">wait only</option>
          </select></label>
          ${kind === "step" && html`
            <label>step <select value=${e.step} onChange=${(ev) => put(i, { step: ev.target.value })}>${options(stepIds, e.step)}</select></label>
            <label>role <select value=${e.role} onChange=${(ev) => put(i, { role: ev.target.value })}>${options([...roles, "human"], e.role)}</select></label>`}
          ${kind === "do" && html`
            <label>do <select value=${e.do} onChange=${(ev) => put(i, { do: ev.target.value })}>${options([...SESSION_ACTIONS, ...actions], e.do)}</select></label>
            ${SESSION_ACTIONS.includes(e.do) && html`<label>role <select value=${e.role} onChange=${(ev) => put(i, { role: ev.target.value })}>${options(roles, e.role)}</select></label>`}
            ${e.do === "type" && html`<label>text <input value=${e.text || ""} onInput=${(ev) => put(i, { text: ev.target.value })} /></label>`}`}
          <label>wait for ${waitObject
            ? html`<span class="muted">${e.wait_for.on} + where/with (edit in YAML)</span>`
            : html`<input list="event-types" placeholder="—" style="width:150px" value=${e.wait_for || ""}
                onChange=${(ev) => put(i, { wait_for: ev.target.value.trim() || undefined })} />`}</label>
          <label>on fail <select value=${failGoto ? "goto" : e.on_fail || "human"}
              onChange=${(ev) => put(i, { on_fail: ev.target.value === "goto" ? { goto: ids[0] } : ev.target.value === "human" ? undefined : ev.target.value })}>
            <option value="human">stop for me</option><option value="retry">retry</option><option value="goto">go to…</option>
          </select>
          ${failGoto && html`<select value=${failGoto} onChange=${(ev) => put(i, { on_fail: { goto: ev.target.value } })}>${options(ids, failGoto)}</select>`}</label>
          <label>retries <input type="number" min="0" style="width:56px" value=${e.retries ?? 3}
            onInput=${(ev) => put(i, { retries: ev.target.value === "" || Number(ev.target.value) === 3 ? undefined : Number(ev.target.value) })} /></label>
          <label>timeout <input style="width:64px" placeholder="2h" value=${e.timeout || ""} onInput=${(ev) => put(i, { timeout: ev.target.value })} /></label>
          <label>then <select value=${(e.after && e.after.goto) || ""} onChange=${(ev) => put(i, { after: ev.target.value ? { goto: ev.target.value } : undefined })}>
            <option value="">next step</option>${ids.map((x) => html`<option value=${x} selected=${x === (e.after && e.after.goto)}>go to ${x}</option>`)}</select></label>
          <label><input type="checkbox" checked=${Boolean(e.detour)} onChange=${(ev) => put(i, { detour: ev.target.checked || undefined })} /> detour</label>
          <label>id <input style="width:110px" placeholder=${ids[i]} value=${e.id || ""} onInput=${(ev) => put(i, { id: ev.target.value })} /></label>
          <button class="danger" onClick=${() => onChange(entries.filter((_, j) => j !== i))}>remove</button>
        </div>
      </div>`;
    })}
    <datalist id="event-types">${options(eventTypes)}</datalist>
    <div class="bar">
      <button onClick=${() => onChange([...entries, clean({ step: stepIds[0], role: roles[0] || "human" })])}>+ step</button>
      <button onClick=${() => onChange([...entries, clean({ do: "clear", role: roles[0] })])}>+ clear / compact</button>
      <button onClick=${() => onChange([...entries, { wait_for: eventTypes.find((t) => t.startsWith("gh.")) || eventTypes[0] }])}>+ wait</button>
    </div>`;
}

function Steps() {
  const { data, error } = useData("/api/steps");
  const [name, setName] = useState("");
  if (!data) return html`<${Loading} error=${error} />`;
  return html`
    <div class="bar"><h1 style="flex:1">Steps</h1>
      <input placeholder="new-step-id" value=${name} onInput=${(e) => setName(e.target.value.trim())} />
      <button disabled=${!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick=${() => go("step", name)}>New</button>
    </div>
    <table>
      <thead><tr><th>step</th><th>summary</th><th>used by</th></tr></thead>
      <tbody>${data.map((s) => html`<tr>
        <td><a href="#/step/${enc(s.id)}">${s.id}</a>${s.errors.length > 0 && html`<div class="err">${s.errors.join("\n")}</div>`}</td>
        <td>${s.summary}</td>
        <td>${s.usedBy.map((p) => html`<a href="#/process/${enc(p)}">${p}</a> `)}</td>
      </tr>`)}</tbody>
    </table>`;
}

function StepEditor({ arg: id }) {
  const { data, error, reload } = useData(`/api/steps/${enc(id)}`, false);
  const { data: runs } = useData("/api/runs?all=1", false);
  const isNew = Boolean(error && error.status === 404);
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [mtime, setMtime] = useState(null);
  const [errors, setErrors] = useState([]);
  const [runId, setRunId] = useState("");
  const [preview, setPreview] = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (data) { setSummary(data.summary); setBody(data.body); setMtime(data.mtime); setErrors(data.errors); setReady(true); }
    else if (isNew) setReady(true);
  }, [data, isNew]);
  if (error && !isNew) return html`<${Loading} error=${error} />`;
  if (!ready) return html`<${Loading} />`;
  const save = async () => {
    try {
      const r = await api("PUT", `/api/steps/${enc(id)}`, { summary, body, mtime });
      setMtime(r.mtime);
      setErrors([]);
    } catch (e) {
      if (e.status === 409) {
        if (confirm("The file changed on disk. Reload it and drop your edits?")) await reload();
        return;
      }
      if (e.data && e.data.errors) setErrors(e.data.errors);
      else alert(e.message);
    }
  };
  const show = async () => {
    try { setPreview(await api("POST", `/api/steps/${enc(id)}/preview`, { body, run: runId || undefined })); }
    catch (e) { setPreview({ error: e.message }); }
  };
  const remove = attempt(async () => {
    if (!confirm(`Delete step ${id}?`)) return;
    await api("DELETE", `/api/steps/${enc(id)}?mtime=${mtime}`);
    go("steps");
  });
  return html`
    <div class="bar"><h1 style="flex:1">step ${id}${isNew ? " (new)" : ""}</h1>
      <button class="primary" onClick=${save}>Save</button>
      ${!isNew && html`<button class="danger" onClick=${remove}>Delete</button>`}
    </div>
    ${errors.length > 0 && html`<pre class="err">${errors.join("\n")}</pre>`}
    <div class="grid2"><label>summary</label><input value=${summary} onInput=${(e) => setSummary(e.target.value)} /></div>
    <p class="muted">Placeholders: {{run.id}} {{run.process}} {{run.iteration}} {{vars.NAME}} {{event.type}} {{event.outcome}} {{event.data.KEY}}. A missing value stops the run for you instead of sending a broken prompt.</p>
    <textarea rows="22" value=${body} onInput=${(e) => setBody(e.target.value)} />
    <div class="bar">
      <select value=${runId} onChange=${(e) => setRunId(e.target.value)}>
        <option value="">preview without a run</option>
        ${(runs || []).map((r) => html`<option value=${r.id}>${r.id}</option>`)}
      </select>
      <button onClick=${show}>Preview</button>
    </div>
    ${preview && (preview.error ? html`<p class="err">${preview.error}</p>` : html`<pre>${preview.text}</pre>`)}`;
}

function Plugins() {
  const { data, error } = useData("/api/plugins");
  if (!data) return html`<${Loading} error=${error} />`;
  const restart = attempt(async () => {
    if (!confirm("Restart flowd? Runs carry on after the restart.")) return;
    await api("POST", "/api/restart");
    setTimeout(() => location.reload(), 2500);
  });
  return html`
    <div class="bar"><h1 style="flex:1">Plugins</h1><button onClick=${restart}>Restart flowd</button></div>
    <p class="muted">Core events: ${data.core.join(", ")}. Ad-hoc events: signal.* (sent with flow signal).</p>
    <table>
      <thead><tr><th>plugin</th><th>events</th><th>actions</th><th>watching</th><th>last error</th></tr></thead>
      <tbody>${data.plugins.map((p) => html`<tr>
        <td>${p.name}<div class="muted"><code>${p.source}</code></div></td>
        <td>${p.events.map((e) => `${p.name}.${e}`).join(", ")}</td>
        <td>${p.actions.join(", ")}</td>
        <td>${p.watches.map((w) => html`<div>${w.run === null
          ? html`trigger · ${(w.processes || []).map((n, i) => html`${i ? ", " : ""}<a href="#/process/${enc(n)}">${n}</a>`)} <span class="muted">${w.type}</span>`
          : html`<a href="#/run/${enc(w.run)}">${w.run}</a> ${w.entry}`} ${w.error && html`<span class="err">${w.error}</span>`}</div>`)}</td>
        <td class="err">${p.lastError || ""}</td>
      </tr>`)}</tbody>
    </table>`;
}

const pages = { runs: Runs, run: Run, processes: Processes, start: StartForm, process: ProcessEditor, steps: Steps, step: StepEditor, plugins: Plugins };
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

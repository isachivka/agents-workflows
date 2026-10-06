// The process and step editors, unchanged from the first UI. Making them approachable is the
// next sub-project (see docs/specs/2026-10-06-plain-ui-design.md, Non-goals).
import { html, useState, useEffect } from "./vendor/preact-htm.js";
import { api, useData, go, attempt, enc, clean, options } from "./lib.js";
import { t } from "./text.js";

const Loading = ({ error }) => (error ? html`<p class="err-box">${error.message}</p>` : html`<p class="muted">${t("loading")}</p>`);

const NEW_PROCESS = { description: "", cwd: "~", repeat: false, roles: { agent: { spawn: "claude --dangerously-skip-permissions" } }, steps: [] };
const SESSION_ACTIONS = ["clear", "compact", "type"];

export function ProcessEditor({ arg: name }) {
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

export function Steps() {
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

export function StepEditor({ arg: id }) {
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

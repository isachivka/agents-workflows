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

/** The PR a human step is about: a var named pr, else the first link among the vars. */
const firstUrl = (vars) => (vars.pr && isUrl(vars.pr) ? vars.pr : Object.values(vars).find(isUrl) || null);

function Now() {
  const { data, error } = useData("/api/runs?all=1");
  const now = useNow();
  const [older, setOlder] = useState(false);
  if (!data) return html`<${Loading} error=${error} />`;
  const live = data.filter(isOpen);
  const waiting = live.filter((r) => r.needsYou).sort((a, b) => waitingSince(a) - waitingSince(b));
  const working = live.filter((r) => !r.needsYou);
  const finished = data.filter((r) => !isOpen(r));
  const today = finished.filter((r) => r.updated >= new Date(now).setHours(0, 0, 0, 0));
  const shown = older ? finished.slice(0, 50) : today;
  const lead = waiting.length
    ? `${tn("now.lead.waiting", waiting.length)}${working.length ? ` ${tn("now.lead.more", working.length)}` : ""}`
    : working.length ? tn("now.lead.working", working.length) : t("now.lead.calm");
  return html`
    <section class="head">
      <div><h1>${t("now.title")}</h1><p class="lead">${data.length ? lead : t("now.empty")}</p></div>
      <a class="btn" href="#/processes">${t("now.start")}</a>
    </section>
    ${waiting.length > 0 && html`<section>
      <h2><${Icon} name="you" />${t("now.waiting")} · ${waiting.length}</h2>
      <div class="stack">${waiting.map((r) => html`<${WaitingCard} r=${r} now=${now} key=${r.id} />`)}</div>
    </section>`}
    ${working.length > 0 && html`<section>
      <h2><${Icon} name="agent" />${t("now.working")} · ${working.length}</h2>
      <div class="grid">${working.map((r) => html`<${WorkingCard} r=${r} now=${now} key=${r.id} />`)}</div>
    </section>`}
    ${finished.length > 0 && html`<section>
      <h2><${Icon} name="check" />${older ? t("now.recent") : t("now.finished")}</h2>
      ${shown.length > 0 && html`<div class="box rows">${shown.map((r) => html`<${FinishedRow} r=${r} now=${now} key=${r.id} />`)}</div>`}
      ${!older && finished.length > today.length && html`<button class="btn quiet" onClick=${() => setOlder(true)}>${t("now.older")}</button>`}
    </section>`}`;
}

function WaitingCard({ r, now }) {
  const [err, setErr] = useState(null);
  const d = describeRun(r);
  const s = situation(r);
  const cur = currentEntry(r);
  const url = firstUrl(r.vars);
  const sid = cur && cur.role && cur.role !== "human" ? r.roles[cur.role] : null;
  const post = (path) => attempt(() => api("POST", `/api/runs/${enc(r.id)}${path}`, {}), setErr);
  return html`<article class="box you">
    <div class="meta"><${Pill} tone="you">${d.tag}<//><span class="muted small">${runLabel(r.id)}</span>
      <span class="muted small when">${t("now.waitedFor", { d: duration(now - waitingSince(r)) })}</span></div>
    <h3>${d.title}</h3>
    ${d.detail && html`<p class="muted">${d.detail}</p>`}
    <${Err} msg=${err} />
    <div class="acts">
      ${s === "human" && url && html`<a class="btn primary" href=${url} target="_blank" rel="noreferrer">${t("act.openPr")}<${Icon} name="external" /></a>`}
      ${s === "human" && !r.waitingOn && html`<button class="btn ${url ? "" : "primary"}" onClick=${post(`/entries/${enc(cur.id)}/done`)}>${t("act.done")}</button>`}
      ${(s === "failed" || s === "stopped") && html`<a class="btn primary" href="#/run/${enc(r.id)}">${t("act.sortOut")}</a>`}
      ${s === "failed" && html`<button class="btn" onClick=${post(`/entries/${enc(cur.id)}/retry`)}>${t("act.retry")}</button>`}
      ${s === "agentAsks" && sid && html`<button class="btn primary" onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.openTerminalOf", { role: cur.role })}</button>`}
      <a class="btn quiet" href="#/run/${enc(r.id)}">${t("act.details")}</a>
    </div>
  </article>`;
}

function WorkingCard({ r, now }) {
  const [err, setErr] = useState(null);
  const d = describeRun(r);
  const cur = currentEntry(r);
  const p = progress(r);
  const sid = cur && cur.kind === "agent" ? r.roles[cur.role] : null;
  const since = r.agentWait ? r.agentWait.since : cur && cur.startedAt;
  return html`<article class="box">
    <div class="meta"><${Pill} tone=${d.tone}>${d.tag}<//><span class="muted small">${runLabel(r.id)}</span></div>
    <h3>${cur && cur.kind === "agent" && html`<span class="who">${cur.role}</span> · `}${d.title}</h3>
    ${d.detail && html`<p class="muted small">${d.detail}</p>`}
    <div class="prog" role="img" aria-label=${t("now.stepOf", { i: p.i, n: p.n })}>${p.segs.map((s) => html`<span class=${s}></span>`)}</div>
    <p class="muted small">${t("now.stepOf", { i: p.i, n: p.n })}${since ? ` · ${duration(now - since)}` : ""}</p>
    <${Err} msg=${err} />
    <div class="acts">
      <a class="btn" href="#/run/${enc(r.id)}">${t("act.details")}</a>
      ${sid && html`<button class="btn quiet" onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.terminal")}</button>`}
    </div>
  </article>`;
}

function FinishedRow({ r, now }) {
  const last = [...r.plan].reverse().find((e) => e.note);
  return html`<div class="row">
    <${Pill} tone=${r.status === "done" ? "ok" : "calm"}>${t(`st.${r.status}`)}<//>
    <a href="#/run/${enc(r.id)}"><b>${runLabel(r.id)}</b></a>
    ${last && html`<span class="muted grow">— ${last.note}</span>`}
    <span class="muted small" style="margin-left:auto">${ago(r.updated, now)}</span>
  </div>`;
}

function Run({ arg: id }) {
  const { data: r, error } = useData(`/api/runs/${enc(id)}`);
  const now = useNow();
  const [err, setErr] = useState(null);
  if (!r) return html`<${Loading} error=${error} />`;
  const post = (path, body = {}) => attempt(() => api("POST", `/api/runs/${enc(id)}${path}`, body), setErr);
  const d = describeRun(r);
  const live = isOpen(r);
  const s = live ? situation(r) : null;
  const stop = () => { if (confirm(t("confirm.stop", { run: runLabel(r.id) }))) post("/stop")(); };
  return html`
    <a class="back small" href="#/runs">← ${t("nav.now")}</a>
    <section class="head">
      <div>
        <div class="title-row"><h1>${runLabel(r.id)}</h1>
          <${Pill} tone=${s ? "you" : r.status === "done" ? "ok" : r.status === "running" ? "work" : "calm"}>${t(`st.${r.status}`)}<//></div>
        <${ProcessLine} name=${r.process} />
        <p class="muted small">${t("run.round", { n: r.iteration })} · ${t("run.started", { when: moment(r.created, now) })}</p>
      </div>
      ${live && html`<div class="acts">
        ${r.status === "paused"
          ? html`<button class="btn" onClick=${post("/resume")}>${t("act.resume")}</button>`
          : html`<button class="btn" onClick=${post("/pause")}>${t("act.pause")}</button>`}
        <button class="btn danger" onClick=${stop}>${t("act.stop")}</button>
      </div>`}
    </section>
    <${Err} msg=${err} />
    ${s && html`<${Decide} r=${r} s=${s} d=${d} post=${post} setErr=${setErr} stop=${stop} />`}
    <div class="cols">
      <section class="main-col"><h2>${t("run.howItGoes")}</h2>
        <${Timeline} r=${r} now=${now} post=${post} setErr=${setErr} live=${live} quiet=${Boolean(s)} /></section>
      <aside class="side-col">
        <${Details} vars=${r.vars} />
        <${Agents} r=${r} post=${post} setErr=${setErr} live=${live} />
        <${History} r=${r} now=${now} />
      </aside>
    </div>`;
}

function ProcessLine({ name }) {
  const { data } = useData("/api/processes", false);
  const p = data && data.find((x) => x.name === name);
  return html`<p class="muted">${p ? `${p.description} ` : ""}<a href="#/process/${enc(name)}">${t("run.howProcess")}</a></p>`;
}

function Decide({ r, s, d, post, setErr, stop }) {
  const cur = currentEntry(r);
  const sid = cur && cur.role && cur.role !== "human" ? r.roles[cur.role] : null;
  const [skipping, setSkipping] = useState(false);
  const [why, setWhy] = useState("");
  const path = cur ? `/entries/${enc(cur.id)}` : "";
  const terminal = sid && html`<button class=${`btn${s === "agentAsks" ? " primary" : ""}`} onClick=${focus(sid, setErr)}>
    <${Icon} name="terminal" />${t("act.openTerminalOf", { role: cur.role })}</button>`;
  return html`<section class="decide" aria-labelledby="decide-h">
    <div class="decide-head">
      <span class="decide-ic"><${Icon} name=${s === "human" ? "you" : "alert"} size=${28} /></span>
      <div><h2 id="decide-h">${d.title}</h2>${s !== "human" && d.detail && html`<blockquote class="quote">${d.detail}</blockquote>`}</div>
    </div>
    ${s === "human" && cur && html`<${HumanStep} r=${r} cur=${cur} post=${post} detail=${d.detail} />`}
    ${s === "agentAsks" && html`<div class="acts">${terminal || html`<p class="muted">${t("run.noSession")}</p>`}</div>`}
    ${(s === "failed" || s === "stopped") && cur && html`
      <h3>${t("run.whatToDo")}</h3>
      <div class="opts">
        <div class="opt rec"><h4>${t("act.retry")}</h4><p class="muted small">${t("why.retry")}</p>
          <button class="btn primary" onClick=${post(`${path}/retry`)}>${t("act.retry")}</button></div>
        ${s === "failed" && html`<div class="opt"><h4>${t("act.skip")}</h4><p class="muted small">${t("why.skip")}</p>
          ${skipping
            ? html`<label class="field small">${t("skip.reason")}<textarea rows="2" value=${why} onInput=${(e) => setWhy(e.target.value)}></textarea></label>
                   <button class="btn" disabled=${!why.trim()} onClick=${post(`${path}/skip`, { note: why.trim() })}>${t("act.skip")}</button>`
            : html`<button class="btn" onClick=${() => setSkipping(true)}>${t("act.skip")}…</button>`}</div>`}
        ${s === "stopped" && cur.kind === "agent" && html`<div class="opt"><h4>${t("act.respawn")}</h4><p class="muted small">${t("why.respawn")}</p>
          <button class="btn" onClick=${post(`/roles/${enc(cur.role)}/respawn`)}>${t("act.respawn")}</button></div>`}
        ${terminal && html`<div class="opt"><h4>${t("act.sortYourself")}</h4><p class="muted small">${t("why.terminal")}</p>${terminal}</div>`}
      </div>
      <div class="decide-foot">
        <${OtherOptions} r=${r} cur=${cur} post=${post} />
        <button class="btn danger" onClick=${stop}>${t("act.stopRun")}</button>
      </div>`}
  </section>`;
}

function HumanStep({ r, cur, post, detail }) {
  const { data } = useData(`/api/runs/${enc(r.id)}/entries/${enc(cur.id)}/prompt`, false);
  const url = firstUrl(r.vars);
  return html`
    ${data && html`<pre class="instr">${data.text}</pre>`}
    <div class="acts">
      ${url && html`<a class=${`btn${r.waitingOn ? " primary" : ""}`} href=${url} target="_blank" rel="noreferrer">${t("act.openPr")}<${Icon} name="external" /></a>`}
      ${r.waitingOn
        ? html`<p class="muted">${detail}</p>`
        : html`<button class="btn primary" onClick=${post(`/entries/${enc(cur.id)}/done`)}>${t("act.done")}</button>`}
    </div>`;
}

function OtherOptions({ r, cur, post }) {
  const { data: sessions } = useData("/api/sessions", false);
  const [target, setTarget] = useState("");
  const [sess, setSess] = useState("");
  return html`<details class="more"><summary>${t("run.otherOptions")}</summary><div class="ov">
    <div><button class="btn" onClick=${post(`/entries/${enc(cur.id)}/done`)}>${t("act.markDone")}</button><span class="muted small">${t("why.markDone")}</span></div>
    <div><select value=${target} onChange=${(e) => setTarget(e.target.value)}>
        <option value="">${t("act.goto")}</option>
        ${r.plan.map((e, i) => html`<option value=${e.id}>${i + 1}. ${entryPhrase(e)}</option>`)}</select>
      <button class="btn" disabled=${!target} onClick=${post(`/entries/${enc(target)}/goto`)}>${t("act.go")}</button></div>
    ${cur.role && cur.role !== "human" && html`<div><select value=${sess} onChange=${(e) => setSess(e.target.value)}>
        <option value="">${t("act.rebind")}</option>
        ${(sessions || []).map((x) => html`<option value=${x.id}>${sessionLabel(x)}</option>`)}</select>
      <button class="btn" disabled=${!sess} onClick=${post(`/roles/${enc(cur.role)}/rebind`, { session: sess })}>${t("act.go")}</button></div>`}
  </div></details>`;
}

const roleChip = (e) => (e.role && e.kind !== "action" ? html`<b class="who">${e.role === "human" ? t("You") : e.role}</b> · ` : "");

function Timeline({ r, now, post, setErr, live, quiet }) {
  // a detour shows once it has been entered
  const shown = r.plan.filter((e) => !e.detour || e.status !== "pending");
  return html`<ol class="tl">${shown.map((e) => {
    const cur = e.id === r.current;
    const finished = e.status === "done" || e.status === "skipped";
    const icon = finished ? "check" : e.status === "failed" ? "cross" : e.kind === "human" ? "you" : e.kind === "wait" ? "wait" : e.kind === "action" ? "again" : "agent";
    const dot = cur ? (e.kind === "human" || e.status === "failed" ? "you" : "cur")
      : finished ? "done" : e.status === "failed" ? "bad" : e.kind === "human" ? "you-next" : "next";
    return html`<li key=${e.id}>
      <span class="dot ${dot}"><${Icon} name=${icon} /></span>
      ${cur
        ? html`<${Current} r=${r} e=${e} now=${now} post=${post} setErr=${setErr} live=${live} quiet=${quiet} />`
        : html`<div class="stp ${e.status === "pending" ? "next" : ""}">
            <span>${roleChip(e)}${entryPhrase(e)}${e.status === "skipped" ? html` <span class="pill">${t("run.skipped")}</span>` : ""}</span>
            ${e.status !== "pending" && (e.startedAt || e.note) && html`<span class="small muted">${e.startedAt ? moment(e.startedAt, now) : ""}${e.note ? ` · “${e.note}”` : ""}</span>`}
            ${e.status === "pending" && entryBranch(e, r.plan).map((b) => html`<span class="small">${b}</span>`)}
          </div>`}
    </li>`;
  })}</ol>`;
}

function Current({ r, e, now, post, setErr, live, quiet }) {
  const [why, setWhy] = useState("");
  const st = r.entries[e.id] || {};
  const sid = e.role && e.role !== "human" ? r.roles[e.role] : null;
  const since = r.agentWait ? r.agentWait.since : e.startedAt;
  const path = `/entries/${enc(e.id)}`;
  return html`<div class="box cur">
    <div class="meta"><${Pill} tone="work">${t("run.now")}<//>
      <span class="muted small">${since ? t("run.running", { d: duration(now - since) }) : ""}${st.attempts > 1 ? ` · ${t("run.attempt", { n: st.attempts })}` : ""}</span></div>
    <h3>${roleChip(e)}${entryPhrase(e)}</h3>
    ${r.agentWait ? html`<p class="muted">${t("run.agentWaitNote", { note: r.agentWait.note })}</p>`
      : r.waitingOn ? html`<p class="muted">${t("wait.for", { what: eventPhrase(r.waitingOn) })}</p>`
      : e.kind === "agent" && html`<p class="muted">${t("run.agentSilent")}</p>`}
    ${sid && html`<div class="acts"><button class="btn primary" onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.openTerminalOf", { role: e.role })}</button></div>`}
    ${(e.kind === "agent" || e.kind === "human") && html`<${PromptFold} run=${r.id} entry=${e.id} label=${e.kind === "agent" ? t("run.toldAgent") : t("proc.toldHuman")} />`}
    ${live && !quiet && html`<details class="more"><summary>${t("run.stepIn")}</summary><div class="ov">
      <div><button class="btn" onClick=${post(`${path}/done`)}>${t("act.markDone")}</button><span class="muted small">${t("why.markDone")}</span></div>
      <div><button class="btn" onClick=${post(`${path}/retry`)}>${t("run.startAgain")}</button><span class="muted small">${t("why.restart")}</span></div>
      <div><input class="grow" placeholder=${t("skip.reason")} value=${why} onInput=${(ev) => setWhy(ev.target.value)} />
        <button class="btn" disabled=${!why.trim()} onClick=${post(`${path}/skip`, { note: why.trim() })}>${t("act.skip")}</button></div>
    </div></details>`}
  </div>`;
}

function PromptFold({ run, entry, label }) {
  const [on, setOn] = useState(false);
  const { data, error } = useData(on ? `/api/runs/${enc(run)}/entries/${enc(entry)}/prompt` : null, false);
  return html`<details class="more" onToggle=${(ev) => setOn(ev.currentTarget.open)}><summary>${label}</summary>
    ${data ? html`<pre class="instr">${data.text}</pre>` : error ? html`<p class="err-box">${error.message}</p>` : on && html`<p class="muted">${t("loading")}</p>`}
  </details>`;
}

function Details({ vars }) {
  const rows = Object.entries(vars);
  return html`<section class="box"><h2>${t("run.details")}</h2>
    ${rows.length === 0 ? html`<p class="muted small">${t("run.noDetails")}</p>`
      : html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${isUrl(v) ? html`<a href=${v} target="_blank" rel="noreferrer">${v}</a>` : v}</dd>`)}</dl>`}
  </section>`;
}

function Agents({ r, post, setErr, live }) {
  const { data: sessions } = useData("/api/sessions", false);
  const [pick, setPick] = useState({});
  const roles = Object.entries(r.roles);
  if (roles.length === 0) return null;
  return html`<section class="box"><h2>${t("run.agents")}</h2>
    ${roles.map(([role, sid]) => {
      const status = sid ? r.sessions[sid] || "unknown" : null;
      return html`<div class="agent" key=${role}>
        <div class="agent-row"><b class="who grow">${role}</b>
          ${sid ? html`<${Pill} tone=${status === "active" ? "work" : status === "blocked" ? "you" : "calm"}>${t(`sess.${status}`)}<//>`
            : html`<span class="muted small">${t("run.noSession")}</span>`}
          ${sid && html`<button class="btn quiet" onClick=${focus(sid, setErr)}>${t("act.terminal")}</button>`}</div>
        ${live && html`<details class="more small"><summary>${t("run.agentMore")}</summary><div class="ov">
          <div><button class="btn" onClick=${post(`/roles/${enc(role)}/respawn`)}>${t("act.respawn")}</button></div>
          <div><select value=${pick[role] || ""} onChange=${(e) => setPick({ ...pick, [role]: e.target.value })}>
              <option value="">${t("act.rebind")}</option>
              ${(sessions || []).map((x) => html`<option value=${x.id}>${sessionLabel(x)}</option>`)}</select>
            <button class="btn" disabled=${!pick[role]} onClick=${post(`/roles/${enc(role)}/rebind`, { session: pick[role] })}>${t("act.go")}</button></div>
        </div></details>`}
      </div>`;
    })}
  </section>`;
}

function History({ r, now }) {
  const lines = r.events.map((e) => [e, eventSentence(e, r.plan)]).filter(([, s]) => s).slice(0, 5);
  return html`<section class="box"><h2>${t("run.happened")}</h2>
    ${lines.length === 0 ? html`<p class="muted small">${t("run.nothingYet")}</p>`
      : html`<ul class="feed">${lines.map(([e, s]) => html`<li><span class="muted">${moment(e.ts, now)}</span><span>${s}</span></li>`)}</ul>`}
    <details class="more small"><summary>${t("run.fullHistory")}</summary><div class="scroll"><table class="tech">
      <thead><tr><th>${t("tech.when")}</th><th>${t("tech.type")}</th><th>${t("tech.step")}</th><th>${t("tech.outcome")}</th><th>${t("tech.data")}</th></tr></thead>
      <tbody>${r.events.map((e) => html`<tr><td class="muted">${new Date(e.ts).toLocaleString(getLang())}</td><td>${e.type}</td>
        <td>${e.entry || e.data.entry || ""}</td><td>${e.outcome || ""}</td><td class="muted"><code>${JSON.stringify(e.data).slice(0, 160)}</code></td></tr>`)}</tbody>
    </table></div></details>
  </section>`;
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

const PAGES = { runs: Now, run: Run, processes: Processes, process: ProcessEditor, start: StartForm, steps: Steps, step: StepEditor, settings: Settings, plugins: Settings };
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

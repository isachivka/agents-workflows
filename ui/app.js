import { html, render, useState, useEffect, useRef } from "./vendor/preact-htm.js";
import { api, useData, useNow, useRoute, go, attempt, focus, isUrl, enc, clean, sessionLabel, Icon, Err } from "./lib.js";
import { issueUrl, prUrl, repoName, slackUrl } from "./pr.js";
import { t, tn, setLang, getLang, defaultLang, LANGS, describeRun, situation, currentEntry, entryPhrase, eventPhrase,
  eventSentence, entryBranch, progress, waitingSince, processFacts, roundsEnded, runTitle, duration, ago, clock, moment, runLabel, holdPhrase,
  stacks, thenPhrase, handedBack, entryBadges, entryFacts, roleLine, entryWho, pileShown, processOf } from "./text.js";
import { ProcessEditor, Steps, StepEditor } from "./editors.js";

const LANG_KEY = "flows.lang";
const HIDDEN_KEY = "flows.hiddenProcesses";
/** The processes the person took off the home screen, kept in this browser only. */
function savedHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { return new Set(); }
}

function savedLang() {
  try { return localStorage.getItem(LANG_KEY) || defaultLang(navigator.language); } catch { return defaultLang(navigator.language); }
}
setLang(savedLang());

const Loading = ({ error }) => (error ? html`<p class="err-box">${error.message}</p>` : html`<p class="muted">${t("loading")}</p>`);
const Pill = ({ tone, children }) => html`<span class="pill ${tone}">${children}</span>`;
const isOpen = (r) => r.status !== "done" && r.status !== "stopped";

/** A run without a title: "Daily errors · 20.10 06:00" (flowd's name), plus "· round 2" once a repeating run is past its first round. */
const runName = (r) => `${r.name || runLabel(r.id)}${r.iteration > 1 ? ` · ${t("run.round", { n: r.iteration })}` : ""}`;
/** The small line over a card's headline: the repo, then the process when the headline is the run's title. */
const cardLabel = (r, about) => [repoName(r.vars), about ? r.label : null].filter(Boolean).join(" · ");
/** The Slack thread and the tracker issue of the run, as buttons, when it has them. */
const WorkLinks = ({ vars, cls = "btn" }) => {
  const url = slackUrl(vars);
  const issue = issueUrl(vars);
  return html`${url && html`<a class=${cls} href=${url} target="_blank" rel="noreferrer">${t("act.openSlack")}<${Icon} name="external" /></a>`}${
    issue && html`<a class=${cls} href=${issue} target="_blank" rel="noreferrer">${vars.issue || t("act.openIssue")}<${Icon} name="external" /></a>`}`;
};

/** Rounds that ended since `since` in the given open runs. The run list only carries the current
 * round, so this reads each repeating run's events; few runs repeat, so a fetch each is fine. */
function useRounds(runs, since) {
  const [rounds, setRounds] = useState([]);
  const ids = (runs || []).filter((r) => isOpen(r) && r.iteration > 1).map((r) => r.id);
  useEffect(() => {
    if (ids.length === 0) { setRounds([]); return undefined; }
    let current = true;
    Promise.all(ids.map((id) => api("GET", `/api/runs/${enc(id)}`).catch(() => null))).then((runs) => {
      if (!current) return;
      setRounds(runs.filter(Boolean).flatMap((d) => roundsEnded(d.events).filter((x) => x.at >= since).map((x) => ({ ...x, run: d.id }))));
    });
    return () => { current = false; };
  }, [runs, since]);
  return rounds;
}


function Now({ hidden, onHidden }) {
  const { data, error } = useData("/api/runs?all=1");
  const { data: sessions } = useData("/api/sessions", false);
  const now = useNow();
  const [older, setOlder] = useState(false);
  const filter = useRef(null);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const allRounds = useRounds(data, dayStart);
  if (!data) return html`<${Loading} error=${error} />`;
  // a run working inside another on the same agent stands for both: one card, the other a tab
  const allPiles = stacks(data.filter(isOpen));
  const piles = allPiles.filter((x) => pileShown(x, hidden));
  const off = allPiles.filter((x) => !pileShown(x, hidden));
  const offWaiting = off.filter((x) => x.top.needsYou).length;
  const rounds = allRounds.filter((round) => !hidden.has(processOf(round.run)));
  const waiting = piles.filter((x) => x.top.needsYou).sort((a, b) => waitingSince(a.top) - waitingSince(b.top));
  const working = piles.filter((x) => !x.top.needsYou);
  const finished = data.filter((r) => !isOpen(r) && !hidden.has(r.process));
  const today = finished.filter((r) => r.updated >= dayStart);
  // a repeating run's finished rounds sit among the finished runs, newest first
  const rows = [...(older ? finished.slice(0, 50) : today).map((r) => ({ at: r.updated, r })), ...rounds.map((round) => ({ at: round.at, round }))]
    .sort((a, b) => b.at - a.at);
  const lead = waiting.length
    ? `${tn("now.lead.waiting", waiting.length)}${working.length ? ` ${tn("now.lead.more", working.length)}` : ""}`
    : working.length ? tn("now.lead.working", working.length) : t("now.lead.calm");
  return html`
    <section class="head">
      <div><h1>${t("now.title")}</h1><p class="lead">${data.length ? lead : t("now.empty")}</p>
        ${off.length > 0 && html`<p class=${`small ${offWaiting ? "you-text" : "muted"}`}>${tn("filter.hidden", off.length)}${offWaiting ? ` · ${t("filter.hiddenWait", { n: offWaiting })}` : ""}${" · "}<button class="link" onClick=${() => { if (filter.current) filter.current.open = true; }}>${t("filter.show")}</button></p>`}</div>
      <div class="actions"><${ProcessFilter} hidden=${hidden} onHidden=${onHidden} det=${filter} />
        <a class="btn" href="#/processes">${t("now.start")}</a></div>
    </section>
    ${waiting.length > 0 && html`<section>
      <h2><${Icon} name="you" />${t("now.waiting")} · ${waiting.length}</h2>
      <div class="stack">${waiting.map((x) => html`<div class="pile" key=${x.top.id}><${StackTabs} under=${x.under} /><${WaitingCard} r=${x.top} now=${now} /></div>`)}</div>
    </section>`}
    ${working.length > 0 && html`<section>
      <h2><${Icon} name="agent" />${t("now.working")} · ${working.length}</h2>
      <div class="grid">${working.map((x) => html`<div class="pile" key=${x.top.id}><${StackTabs} under=${x.under} /><${WorkingCard} r=${x.top} now=${now} /></div>`)}</div>
    </section>`}
    ${(finished.length > 0 || rounds.length > 0) && html`<section>
      <h2><${Icon} name="check" />${older ? t("now.recent") : t("now.finished")}</h2>
      ${rows.length === 0 && html`<p class="muted">${t("now.noneToday")}</p>`}
      ${rows.length > 0 && html`<div class="box rows">${rows.map((x) => (x.r
        ? html`<${FinishedRow} r=${x.r} now=${now} sessions=${sessions} key=${x.r.id} />`
        : html`<${RoundRow} round=${x.round} now=${now} key=${`${x.round.run}/${x.round.iteration}`} />`))}</div>`}
      ${!older && finished.length > today.length && html`<button class="btn quiet" onClick=${() => setOlder(true)}>${t("now.older")}</button>`}
    </section>`}`;
}

/** Checkboxes, one per process: an unchecked one's runs leave the home screen. */
function ProcessFilter({ hidden, onHidden, det }) {
  const { data } = useData("/api/processes", false);
  const flip = (name) => { const next = new Set(hidden); if (next.has(name)) next.delete(name); else next.add(name); onHidden(next); };
  return html`<details class="filter" ref=${det}>
    <summary class="btn">${t("filter.button")} · ${hidden.size ? t("filter.some", { n: hidden.size }) : t("filter.all")}</summary>
    <div class="box filter-list">
      ${(data || []).map((p) => html`<label class="check" key=${p.name}><input type="checkbox" checked=${!hidden.has(p.name)} onChange=${() => flip(p.name)} />
        <span>${p.label || p.name}${p.label && html` <span class="muted small mono">${p.name}</span>`}</span></label>`)}
      ${hidden.size > 0 && html`<button class="btn quiet" onClick=${() => onHidden(new Set())}>${t("filter.showAll")}</button>`}
    </div></details>`;
}

function WaitingCard({ r, now }) {
  const [err, setErr] = useState(null);
  const d = describeRun(r);
  const s = situation(r);
  const cur = currentEntry(r);
  const url = prUrl(r.vars);
  const sid = cur && cur.role && cur.role !== "human" ? r.roles[cur.role] : null;
  const post = (path) => attempt(() => api("POST", `/api/runs/${enc(r.id)}${path}`, {}), setErr);
  const about = runTitle(r);
  return html`<article class="box you">
    <div class="meta"><${Pill} tone="you">${d.tag}<//>${cardLabel(r, about) && html`<span class="muted small">${cardLabel(r, about)}</span>`}
      <span class="muted small when">${t("now.waitedFor", { d: duration(now - waitingSince(r)) })}</span></div>
    <h3 class="about" title=${about ? r.vars.title : undefined}>${about || runName(r)}</h3>
    <p class="step">${d.title}</p>
    ${d.detail && html`<p class="muted">${d.detail}</p>`}
    <${Err} msg=${err} />
    <div class="acts">
      ${url && html`<a class="btn ${s === "human" ? "primary" : ""}" href=${url} target="_blank" rel="noreferrer">${t("act.openPr")}<${Icon} name="external" /></a>`}
      <${WorkLinks} vars=${r.vars} />
      ${s === "human" && !r.waitingOn && html`<button class="btn ${url ? "" : "primary"}" onClick=${post(`/entries/${enc(cur.id)}/done`)}>${t("act.done")}</button>`}
      ${(s === "failed" || s === "stopped") && html`<a class="btn primary" href="#/run/${enc(r.id)}">${t("act.sortOut")}</a>`}
      ${s === "failed" && html`<button class="btn" onClick=${post(`/entries/${enc(cur.id)}/retry`)}>${t("act.retry")}</button>`}
      ${s === "agentAsks" && sid && html`<button class="btn primary" onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.openTerminalOf", { role: cur.role })}</button>`}
      ${s === "nest" && html`<${NestPicker} r=${r} cur=${cur} setErr=${setErr} />`}
      <${PingButton} r=${r} setErr=${setErr} />
      <a class="btn quiet" href="#/run/${enc(r.id)}">${t("act.details")}</a>
    </div>
  </article>`;
}

/** The runs under a nested one, as tabs above its card: the deepest furthest back, each a link. */
function StackTabs({ under }) {
  return [...under].reverse().map((u, i, all) => html`<a class="under${u.needsYou ? " you" : ""}" key=${u.id} href="#/run/${enc(u.id)}"
      style=${`margin: 0 ${Math.min(all.length - i, 3) * 16}px`}>
    <span>${t(all.length > 1 && i === 0 ? "stack.bottom" : "stack.under")}</span><b>${runLabel(u.id)}</b>${thenPhrase(u) && html`<span>${thenPhrase(u)}</span>`}
  </a>`);
}

const shortText = (s) => { const one = s.split(/(?<=[.!?])\s/)[0]; return one.length > 70 ? `${one.slice(0, 67)}…` : one; };

/** A run waits on a bare inner: pick the process to run there on that agent, or skip the step. */
function NestPicker({ r, cur, setErr }) {
  const { data } = useData("/api/processes", false);
  const [pick, setPick] = useState("");
  // only what can take this agent: a role named like the inner's, or a single role (as flowd picks)
  const list = (data || []).filter((p) => p.valid && !p.repeat && (p.roles.includes(cur.role) || p.roles.length === 1));
  const chosen = pick || (list[0] ? list[0].name : "");
  const start = attempt(() => api("POST", `/api/runs/${enc(r.id)}/nest`, { process: chosen }), setErr);
  const skip = attempt(() => api("POST", `/api/runs/${enc(r.id)}/entries/${enc(cur.id)}/skip`, { note: t("nest.skipNote") }), setErr);
  return html`<label class="field small">${t("nest.pick")}
      <select onChange=${(e) => setPick(e.target.value)}>${list.map((p) => html`<option value=${p.name} selected=${p.name === chosen}>${p.name}${p.description ? ` — ${shortText(p.description)}` : ""}</option>`)}</select></label>
    <button class="btn primary" disabled=${!chosen} onClick=${start}>${t("nest.start", { role: cur.role })}</button>
    <button class="btn quiet" onClick=${skip}>${t("nest.skip")}</button>`;
}

function WorkingCard({ r, now }) {
  const [err, setErr] = useState(null);
  const d = describeRun(r);
  const cur = currentEntry(r);
  const p = progress(r);
  const sid = cur && cur.kind === "agent" ? r.roles[cur.role] : null;
  const since = r.agentWait ? r.agentWait.since : cur && cur.startedAt;
  const url = prUrl(r.vars);
  const about = runTitle(r);
  return html`<article class="box">
    <div class="meta"><${Pill} tone=${d.tone}>${d.tag}<//>${cardLabel(r, about) && html`<span class="muted small">${cardLabel(r, about)}</span>`}</div>
    <h3 class="about" title=${about ? r.vars.title : undefined}>${about || runName(r)}</h3>
    <p class="step">${cur && cur.kind === "agent" && html`<span class="who">${cur.role}</span> · `}${d.title}</p>
    ${d.detail && html`<p class="muted small">${d.detail}</p>`}
    <div class="prog" role="img" aria-label=${t("now.stepOf", { i: p.i, n: p.n })}>${p.segs.map((s) => html`<span class=${s}></span>`)}</div>
    <p class="muted small">${t("now.stepOf", { i: p.i, n: p.n })}${since ? ` · ${duration(now - since)}` : ""}</p>
    <${Err} msg=${err} />
    <div class="acts">
      <a class="btn" href="#/run/${enc(r.id)}">${t("act.details")}</a>
      ${url && html`<a class="btn" href=${url} target="_blank" rel="noreferrer">${t("act.openPr")}<${Icon} name="external" /></a>`}
      <${WorkLinks} vars=${r.vars} />
      ${sid && html`<button class="btn quiet" onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.terminal")}</button>`}
      <${PingButton} r=${r} setErr=${setErr} />
    </div>
  </article>`;
}

// a run waits for someone (a review, a merge) and has an agent that can nudge them
const canPing = (r) => r.status === "running" && Boolean(r.waitingOn) && Object.values(r.roles).some(Boolean);

function PingButton({ r, setErr }) {
  const [sent, setSent] = useState(false);
  if (!canPing(r)) return null;
  const ping = attempt(async () => { await api("POST", `/api/runs/${enc(r.id)}/ping`, {}); setSent(true); }, setErr);
  return html`<button class="btn quiet" disabled=${sent} title=${t("why.ping")} onClick=${ping}><${Icon} name=${sent ? "check" : "bell"} />${t(sent ? "act.pinged" : "act.ping")}</button>`;
}

// a Claude agent whose session is gone (the last step closed it): its conversation can come back
const goneAgents = (r, sessions) => (sessions && !isOpen(r)
  ? r.resumable.filter((role) => r.roles[role] && !sessions.some((x) => x.id === r.roles[role])) : []);

function RestoreButton({ r, role, many, setErr, cls = "btn quiet" }) {
  const restore = attempt(() => api("POST", `/api/runs/${enc(r.id)}/roles/${enc(role)}/restore`, {}), setErr);
  return html`<button class=${cls} title=${t("why.restore")} onClick=${restore}><${Icon} name="again" />${many ? t("act.restoreOf", { role }) : t("act.restore")}</button>`;
}

function FinishedRow({ r, now, sessions }) {
  const [err, setErr] = useState(null);
  const last = [...r.plan].reverse().find((e) => e.note);
  const gone = goneAgents(r, sessions);
  return html`<div class="row">
    <${Pill} tone=${r.status === "done" ? "ok" : "calm"}>${t(`st.${r.status}`)}<//>
    <a href="#/run/${enc(r.id)}"><b>${runTitle(r) || runName(r)}</b></a>
    ${(runTitle(r) || repoName(r.vars)) && html`<span class="muted small">${[repoName(r.vars), runTitle(r) ? r.label : null].filter(Boolean).join(" · ")}</span>`}
    ${last && html`<span class="muted grow note" title=${last.note}>— ${last.note}</span>`}
    ${prUrl(r.vars) && html`<a class="small" href=${prUrl(r.vars)} target="_blank" rel="noreferrer">PR<${Icon} name="external" /></a>`}
    <${WorkLinks} vars=${r.vars} cls="small" />
    ${gone.map((role) => html`<${RestoreButton} r=${r} role=${role} many=${gone.length > 1} setErr=${setErr} cls="btn quiet small" key=${role} />`)}
    <span class="muted small" style="margin-left:auto">${ago(r.updated, now)}</span>
    ${err && html`<span class="err-box small" role="alert">${err}</span>`}
  </div>`;
}

function RoundRow({ round, now }) {
  return html`<div class="row">
    <${Pill} tone="ok">${t("tag.roundDone")}<//>
    <a href="#/run/${enc(round.run)}"><b>${runLabel(round.run)} · ${t("run.round", { n: round.iteration })}</b></a>
    ${round.note && html`<span class="muted grow note" title=${round.note}>— ${round.note}</span>`}
    <span class="muted small" style="margin-left:auto">${ago(round.at, now)}</span>
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
        <div class="title-row"><h1 title=${runTitle(r) ? r.vars.title : undefined}>${runTitle(r) || runName(r)}</h1>
          <${Pill} tone=${s ? "you" : r.status === "done" ? "ok" : r.status === "running" ? "work" : "calm"}>${s ? t("st.needs-human") : t(`st.${r.status}`)}<//></div>
        <${ProcessLine} name=${r.process} />
        <p class="muted small">${repoName(r.vars) ? `${repoName(r.vars)} · ` : ""}${runLabel(r.id)} · ${t("run.round", { n: r.iteration })} · ${t("run.started", { when: moment(r.created, now) })}</p>
      </div>
      ${live && html`<div class="acts">
        <${PingButton} r=${r} setErr=${setErr} />
        ${r.status === "paused" && html`<button class="btn" onClick=${post("/resume")}>${t("act.resume")}</button>`}
        ${r.status === "running" && html`<button class="btn" onClick=${post("/pause")}>${t("act.pause")}</button>`}
        <button class="btn danger" onClick=${stop}>${t("act.stop")}</button>
      </div>`}
    </section>
    <${Err} msg=${err} />
    ${live && r.parent && html`<${AfterThis} r=${r} />`}
    ${s && s !== "nest" && html`<${Decide} key=${r.current} r=${r} s=${s} d=${d} post=${post} setErr=${setErr} stop=${stop} />`}
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
          <button class="btn" onClick=${() => { if (confirm(t("confirm.respawn", { role: cur.role }))) post(`/roles/${enc(cur.role)}/respawn`)(); }}>${t("act.respawn")}</button></div>`}
        ${terminal && html`<div class="opt"><h4>${t("act.sortYourself")}</h4><p class="muted small">${t("why.terminal")}</p>${terminal}</div>`}
      </div>`}
    ${cur && html`<div class="decide-foot">
      <${OtherOptions} r=${r} cur=${cur} post=${post} />
      <button class="btn danger" onClick=${stop}>${t("act.stopRun")}</button>
    </div>`}
  </section>`;
}

function HumanStep({ r, cur, post, detail }) {
  const { data, error } = useData(`/api/runs/${enc(r.id)}/entries/${enc(cur.id)}/prompt`, false);
  const url = prUrl(r.vars);
  return html`
    ${error && html`<p class="err-box">${error.message}</p>`}
    ${data && html`<details class="more"><summary>${t("proc.toldHuman")}</summary><pre class="instr">${data.text}</pre></details>`}
    <div class="acts">
      ${url && html`<a class=${`btn${r.waitingOn ? " primary" : ""}`} href=${url} target="_blank" rel="noreferrer">${t("act.openPr")}<${Icon} name="external" /></a>`}
      <${WorkLinks} vars=${r.vars} />
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

/** On a nested run's page: the run it lies on, and what happens when it ends. */
function AfterThis({ r }) {
  const { data: p } = useData(`/api/runs/${enc(r.parent)}`, false);
  if (!p) return null;
  const back = handedBack(r, p);
  return html`<div class="pile">
    <a class="under" href="#/run/${enc(p.id)}" style="margin: 0 16px"><span>${t("stack.onTop")}</span><b>${runLabel(p.id)}</b><span>${t("stack.waits")}</span></a>
    <section class="box"><h2>${t("after.title")}</h2><div class="after">
      <div><b>${t("after.goesOn", { run: runLabel(p.id) })}</b><span class="muted small">${thenPhrase(p) || ""}</span></div>
      <div><b>${t("after.back")}</b><span class="muted small">${back.length ? back.join(", ") : t("after.nothingBack")}</span></div>
      <div><b>${t("after.stop")}</b><span class="muted small">${t("after.stopText", { run: runLabel(p.id) })}</span></div>
    </div></section>
  </div>`;
}

/** The steps of a nested run, small, inside its parent's inner step. */
function ChildSteps({ id }) {
  const { data: c } = useData(`/api/runs/${enc(id)}`, false);
  if (!c) return null;
  const shown = c.plan.filter((e) => !e.detour || e.status !== "pending");
  return html`<ol class="mini">${shown.map((e) => {
    const dot = e.id === c.current ? "cur" : e.status === "done" || e.status === "skipped" ? "done" : e.kind === "human" ? "you" : "";
    return html`<li key=${e.id}><span class="md ${dot}"></span><span class=${e.id === c.current ? "" : "muted"}>${roleChip(e)}${entryPhrase(e)}</span></li>`;
  })}</ol>`;
}

/** The current inner step: the nested run working inside, or the choice of one. */
function CurrentInner({ r, e, setErr, live }) {
  const stopChild = attempt(async () => {
    if (confirm(t("confirm.stop", { run: runLabel(e.child) }))) await api("POST", `/api/runs/${enc(e.child)}/stop`, {});
  }, setErr);
  if (!e.child) {
    return html`<div class="box you">
      <div class="meta"><${Pill} tone="you">${t("tag.nest")}<//></div>
      <h3>${t("nest.title", { role: e.role })}</h3>
      ${live && html`<div class="acts"><${NestPicker} r=${r} cur=${e} setErr=${setErr} /></div>`}
    </div>`;
  }
  return html`<div class="box cur">
    <div class="meta"><${Pill} tone="work">${t("run.now")}<//></div>
    <h3>${t("inner.runs")} <a href="#/run/${enc(e.child)}">${runLabel(e.child)}</a></h3>
    <p class="muted">${t("inner.agentOn", { role: e.role, run: runLabel(r.id) })}</p>
    <${ChildSteps} id=${e.child} />
    ${live && html`<details class="more"><summary>${t("run.stepIn")}</summary><div class="ov">
      <div><button class="btn danger" onClick=${stopChild}>${t("inner.stop", { run: runLabel(e.child) })}</button><span class="muted small">${t("why.stopChild")}</span></div>
      <div><span class="muted small">${t("inner.noSkip")}</span></div>
    </div></details>`}
  </div>`;
}

function Current({ r, e, now, post, setErr, live, quiet }) {
  const [why, setWhy] = useState("");
  if (e.kind === "inner") return html`<${CurrentInner} r=${r} e=${e} setErr=${setErr} live=${live} />`;
  const st = r.entries[e.id] || {};
  const sid = e.role && e.role !== "human" ? r.roles[e.role] : null;
  const since = r.agentWait ? r.agentWait.since : e.startedAt;
  const path = `/entries/${enc(e.id)}`;
  return html`<div class="box cur">
    <div class="meta"><${Pill} tone=${quiet ? "you" : "work"}>${quiet ? describeRun(r).tag : t("run.now")}<//>
      <span class="muted small">${[!quiet && r.status !== "paused" && since ? t("run.running", { d: duration(now - since) }) : "", st.attempts > 1 ? t("run.attempt", { n: st.attempts }) : ""].filter(Boolean).join(" · ")}</span></div>
    <h3>${roleChip(e)}${entryPhrase(e)}</h3>
    ${r.agentWait ? html`<p class="muted">${t("run.agentWaitNote", { note: r.agentWait.note })}</p>`
      : r.heldBy ? html`<p class="muted">${holdPhrase(r.heldBy)}</p>`
      : r.waitingOn ? html`<p class="muted">${t("wait.for", { what: eventPhrase(r.waitingOn) })}</p>`
      : e.kind === "agent" && !quiet && html`<p class="muted">${t("run.agentSilent")}</p>`}
    ${sid && html`<div class="acts"><button class=${`btn${quiet ? "" : " primary"}`} onClick=${focus(sid, setErr)}><${Icon} name="terminal" />${t("act.openTerminalOf", { role: e.role })}</button></div>`}
    ${(e.kind === "agent" || e.kind === "human") && html`<${PromptFold} run=${r.id} entry=${e.id} step=${e.step} label=${e.kind === "agent" ? t("run.toldAgent") : t("proc.toldHuman")} />`}
    ${live && !quiet && html`<details class="more"><summary>${t("run.stepIn")}</summary><div class="ov">
      <div><button class="btn" onClick=${post(`${path}/done`)}>${t("act.markDone")}</button><span class="muted small">${t("why.markDone")}</span></div>
      <div><button class="btn" onClick=${post(`${path}/retry`)}>${t("run.startAgain")}</button><span class="muted small">${t("why.restart")}</span></div>
      <div><input class="grow" placeholder=${t("skip.reason")} value=${why} onInput=${(ev) => setWhy(ev.target.value)} />
        <button class="btn" disabled=${!why.trim()} onClick=${post(`${path}/skip`, { note: why.trim() })}>${t("act.skip")}</button></div>
    </div></details>`}
  </div>`;
}

function PromptFold({ run, entry, step, label }) {
  const [on, setOn] = useState(false);
  const { data, error } = useData(on ? `/api/runs/${enc(run)}/entries/${enc(entry)}/prompt` : null, false);
  return html`<details class="more" onToggle=${(ev) => setOn(ev.currentTarget.open)}><summary>${label}</summary>
    ${data ? (step ? html`<${Prompt} key=${getLang()} step=${step} text=${data.text} />` : html`<pre class="instr">${data.text}</pre>`)
      : error ? html`<p class="err-box">${error.message}</p>` : on && html`<p class="muted">${t("loading")}</p>`}
  </details>`;
}

function Details({ vars }) {
  const rows = Object.entries(vars);
  return html`<section class="box"><h2>${t("run.details")}</h2>
    ${rows.length === 0 ? html`<p class="muted small">${t("run.noDetails")}</p>`
      : html`<dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${isUrl(v) ? html`<a href=${v} target="_blank" rel="noreferrer">${v}</a>`
        : k === "issue" && issueUrl(vars) ? html`<a href=${issueUrl(vars)} target="_blank" rel="noreferrer">${v}</a>` : v}</dd>`)}</dl>`}
  </section>`;
}

function Agents({ r, post, setErr, live }) {
  const { data: sessions } = useData("/api/sessions", false);
  const [pick, setPick] = useState({});
  const cur = currentEntry(r);
  const roles = Object.entries(r.roles);
  if (roles.length === 0) return null;
  return html`<section class="box"><h2>${t("run.agents")}</h2>
    ${roles.map(([role, sid]) => {
      const status = sid ? r.sessions[sid] || "unknown" : null;
      const lent = cur && cur.kind === "inner" && cur.child && cur.role === role;
      // hibernate closed it: the next line to it, or Wake, resumes its conversation
      if ((r.asleep || []).includes(role)) {
        const wake = attempt(() => api("POST", `/api/runs/${enc(r.id)}/roles/${enc(role)}/restore`, {}), setErr);
        return html`<div class="agent" key=${role}><div class="agent-row"><b class="who grow">${role}</b>
          <${Pill} tone="calm">${t("agent.asleep")}<//><button class="btn quiet" title=${t("why.wake")} onClick=${wake}>${t("act.wake")}</button></div></div>`;
      }
      return html`<div class="agent" key=${role}>
        <div class="agent-row"><b class="who grow">${role}</b>
          ${lent ? html`<${Pill} tone="work">${t("agent.busyWith", { run: runLabel(cur.child) })}<//>` : sid ? html`<${Pill} tone=${status === "active" ? "work" : status === "blocked" ? "you" : "calm"}>${t(`sess.${status}`)}<//>`
            : live && html`<span class="muted small">${t("run.noSession")}</span>`}
          ${sessions && goneAgents(r, sessions).includes(role)
            ? html`<${RestoreButton} r=${r} role=${role} setErr=${setErr} />`
            : sid && html`<button class="btn quiet" onClick=${focus(sid, setErr)}>${t("act.terminal")}</button>`}</div>
        ${live && html`<details class="more small"><summary>${t("run.agentMore")}</summary><div class="ov">
          <div><button class="btn" onClick=${() => { if (confirm(t("confirm.respawn", { role }))) post(`/roles/${enc(role)}/respawn`)(); }}>${t("act.respawn")}</button></div>
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
      : html`<ul class="feed">${lines.map(([e, s]) => html`<li><span class="muted tm">${moment(e.ts, now)}</span><span>${s}</span></li>`)}</ul>`}
    <details class="more small"><summary>${t("run.fullHistory")}</summary><div class="scroll"><table class="tech">
      <thead><tr><th>${t("tech.when")}</th><th>${t("tech.type")}</th><th>${t("tech.step")}</th><th>${t("tech.outcome")}</th><th>${t("tech.data")}</th></tr></thead>
      <tbody>${r.events.map((e) => html`<tr><td class="muted">${new Date(e.ts).toLocaleString(getLang())}</td><td>${e.type}</td>
        <td>${e.entry || e.data.entry || ""}</td><td>${e.outcome || ""}</td><td class="muted"><code>${JSON.stringify(e.data).slice(0, 160)}</code></td></tr>`)}</tbody>
    </table></div></details>
  </section>`;
}

const DefErrors = ({ p }) => html`
  ${p.errors.length > 0 && html`<div class="err-box">${[t("proc.invalid"), ...p.errors].join("\n")}</div>`}
  ${(p.triggerErrors || []).length > 0 && html`<div class="err-box">${[t("proc.triggerErrors"), ...p.triggerErrors].join("\n")}</div>`}`;

function Processes() {
  const { data, error } = useData("/api/processes");
  const { data: runs } = useData("/api/runs");
  if (!data) return html`<${Loading} error=${error} />`;
  return html`
    <section class="head"><div><h1>${t("nav.processes")}</h1><p class="lead">${t("procs.lead")}</p></div></section>
    ${data.length === 0 && html`<p class="muted">${t("procs.empty")}</p>`}
    <div class="stack">${[...data].sort((a, b) => Number(!a.valid) - Number(!b.valid)).map((p) => html`<article class="box" key=${p.name}>
      <h3><a href="#/process/${enc(p.name)}">${p.label || p.name}</a>${p.label && html` <span class="muted small mono">${p.name}</span>`}</h3>
      ${p.description && html`<p class="muted">${p.description}</p>`}
      ${p.valid && html`<p class="small muted">${tn("proc.steps", p.entries.length)} · ${processFacts(p).join(" · ")}</p>`}
      <${DefErrors} p=${p} />
      <div class="acts">
        ${p.valid && html`<button class="btn primary" onClick=${() => go("start", p.name)}>${t("act.start")}</button>`}
        <a class="btn" href="#/process/${enc(p.name)}">${t("act.details")}</a>
        ${p.openRuns.map((rid) => {
          const r = (runs || []).find((x) => x.id === rid);
          const d = r && describeRun(r);
          return html`<a class="btn quiet run-chip" href="#/run/${enc(rid)}"><span class="clip">${r ? runTitle(r) || runName(r) : runLabel(rid)}</span>${d && html` <${Pill} tone=${d.tone}>${d.tag}<//>`}</a>`;
        })}
      </div>
    </article>`)}</div>
    <${NewProcess} />`;
}

function NewProcess() {
  const [name, setName] = useState("");
  return html`<details class="more"><summary>${t("proc.new")}</summary><div class="acts" style="margin-top:10px">
    <input placeholder="my-process" value=${name} onInput=${(e) => setName(e.target.value.trim())} />
    <button class="btn" disabled=${!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick=${() => go("process", name, "edit")}>${t("act.create")}</button>
  </div></details>`;
}

const look = (e) => ({
  icon: e.kind === "human" ? "you" : e.kind === "wait" || e.kind === "delay" ? "wait" : e.kind === "inner" ? "nest" : e.kind === "action" ? (e.sh ? "shell" : "again") : "agent",
  dot: e.kind === "human" ? "hu" : e.kind === "agent" ? "ag" : e.kind === "action" ? "sy" : "wt",
});
const stepHref = (name, id) => `#/process/${enc(name)}/step/${enc(id)}`;

function ProcessView({ arg: name, sub, rest }) {
  const { data, error } = useData("/api/processes");
  const { data: runs } = useData("/api/runs");
  const { data: steps } = useData("/api/steps", false);
  if (sub === "edit") return html`<${ProcessEditor} arg=${name} />`;
  if (!data) return html`<${Loading} error=${error} />`;
  const p = data.find((x) => x.name === name);
  if (!p) return html`<p class="err-box">${t("proc.missing", { name })}</p>`;
  const human = p.entries.some((e) => e.role === "human");
  const at = sub === "step" ? p.entries.findIndex((e) => e.id === rest) : -1;
  return html`
    <a class="back small" href="#/processes">← ${t("proc.all")}</a>
    <section class="head">
      <div><h1>${p.label || p.name}</h1>${p.label && html`<p class="muted small mono">${p.name}</p>`}${p.description && html`<p class="lead">${p.description}</p>`}
        ${p.valid && html`<div class="facts">${processFacts(p).map((f) => html`<span class="fact">${f}</span>`)}</div>`}</div>
      <div class="acts">
        ${p.valid && html`<button class="btn primary" onClick=${() => go("start", p.name)}>${t("act.start")}</button>`}
        <a class="btn quiet" href="#/process/${enc(p.name)}/edit">${t("act.edit")}</a>
      </div>
    </section>
    <${DefErrors} p=${p} />
    <div class=${`read${at >= 0 ? " open" : ""}`}>
      <div class="readl">
        ${p.openRuns.length > 0 && html`<section><h2>${t("proc.openRuns")}</h2><div class="acts">
          ${p.openRuns.map((rid) => {
            const r = (runs || []).find((x) => x.id === rid);
            const d = r && describeRun(r);
            return html`<a class="btn run-chip" href="#/run/${enc(rid)}"><span class="clip">${r ? runTitle(r) || runName(r) : runLabel(rid)}</span>${d && html` <${Pill} tone=${d.tone}>${d.tag}<//>`}</a>`;
          })}</div></section>`}
        ${(p.roleDefs.length > 0 || human) && html`<section><h2>${t("proc.who")}</h2><div class="ppl">
          ${p.roleDefs.map((rd) => html`<div class="person"><span class=${`dot ${rd.agent === "codex" ? "cx" : "ag"}`}><${Icon} name="agent" /></span><span><b>${rd.name}</b><small>${roleLine(rd, p.cwd)}</small></span></div>`)}
          ${human && html`<div class="person"><span class="dot hu"><${Icon} name="you" /></span><span><b>${t("You")}</b><small>${t("proc.youDo")}</small></span></div>`}
        </div></section>`}
        ${p.entries.length > 0 && html`<section><h2>${t("proc.how")} <span class="muted small hint">— ${t("read.hint")}</span></h2>
          <ol class="steps">${p.entries.map((e, i) => html`<${ProcessEntry} e=${e} i=${i} p=${p} on=${i === at} key=${e.id} />`)}</ol>
          ${p.repeat && html`<p class="loop"><${Icon} name="again" />${t("proc.again")}</p>`}
        </section>`}
      </div>
      ${at >= 0 && html`<${StepPanel} p=${p} i=${at} steps=${steps} key=${p.entries[at].id} />`}
    </div>`;
}

function ProcessEntry({ e, i, p, on }) {
  const { icon, dot } = look(e);
  const badges = entryBadges(e);
  return html`<li><a class=${`pstep${e.kind === "action" ? " sys" : ""}${e.detour ? " det" : ""}${on ? " on" : ""}`}
      href=${stepHref(p.name, e.id)} aria-current=${on ? "step" : undefined}>
    <span class="num">${i + 1}</span>
    <span class=${`dot ${dot}`}><${Icon} name=${icon} /></span>
    <span class="stp">
      <span>${roleChip(e)}${entryPhrase(e)}${e.detour ? html` <${Pill} tone="calm">${t("run.onlyIfNeeded")}<//>` : ""}</span>
      ${badges.length > 0 && html`<span class="badges">${badges.map((b) => html`<span class=${`badge ${b.tone}`}>${b.text}</span>`)}</span>`}
      ${entryBranch(e, p.entries).map((b) => html`<span class="branch small">${b}</span>`)}
    </span>
  </a></li>`;
}

function StepPanel({ p, i, steps }) {
  const e = p.entries[i];
  const { data: step, error } = useData(e.step ? `/api/steps/${enc(e.step)}` : null, false);
  const close = useRef(null);
  // below the breakpoint the panel is a sheet over the list: focus moves into it, off the hidden card
  useEffect(() => { if (matchMedia("(max-width: 960px)").matches && close.current) close.current.focus(); }, []);
  useEffect(() => {
    const on = (ev) => { if (ev.key === "Escape") go("process", p.name); };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [p.name]);
  const { icon, dot } = look(e);
  const prev = p.entries[i - 1], next = p.entries[i + 1];
  const usedBy = ((steps || []).find((s) => s.id === e.step) || { usedBy: [] }).usedBy.filter((x) => x !== p.name);
  const short = (x) => { const s = entryPhrase(x); return s.length > 28 ? `${s.slice(0, 27)}…` : s; };
  return html`<aside class="panel" aria-label=${t("read.panel")}>
    <div class="phead">
      <div class="prow"><span class="small muted grow">${t("read.of", { n: i + 1, total: p.entries.length })}${e.step ? html` · <span class="mono">${e.step}</span>` : ""}</span>
        <a class="x" ref=${close} href=${`#/process/${enc(p.name)}`} aria-label=${t("act.close")}><${Icon} name="close" /></a></div>
      <div class="ptitle"><span class=${`dot ${dot}`}><${Icon} name=${icon} /></span>
        <div><span class="small muted">${entryWho(e, p.roleDefs)}</span><h2>${entryPhrase(e)}</h2></div></div>
    </div>
    <div class="pbody">
      <section><h3>${t("read.how")}</h3>
        <dl class="how">${entryFacts(e, p.roleDefs).map((f) => html`<dt>${f.k}</dt><dd class=${f.mono ? "mono" : ""}>${f.v}</dd>`)}</dl>
        ${entryBranch(e, p.entries).map((b) => html`<p class="branch small">${b}</p>`)}
      </section>
      ${e.step && html`<section>${step
        ? html`<${Prompt} key=${getLang()} step=${e.step} text=${step.body} head=${t(e.kind === "human" ? "proc.toldHuman" : "proc.told")} />`
        : html`<${Loading} error=${error} />`}</section>`}
      <section><h3>${t("read.where")}</h3>
        ${step && html`<${PathRow} label=${t("read.stepFile")} path=${step.path} />`}
        <${PathRow} label=${t("read.procFile", { n: i + 1 })} path=${p.path} />
        ${e.step && html`<p class="small muted">${steps ? (usedBy.length ? t("proc.usedIn", { list: usedBy.join(", ") }) : t("proc.usedNowhere")) : ""}${" "}
          <a href="#/step/${enc(e.step)}">${t("act.editText")}</a></p>`}
      </section>
    </div>
    <div class="pfoot">
      ${prev ? html`<a class="btn quiet sm" href=${stepHref(p.name, prev.id)}>‹ ${i} · ${short(prev)}</a>` : html`<span></span>`}
      ${next && html`<a class="btn quiet sm" href=${stepHref(p.name, next.id)}>${i + 2} · ${short(next)} ›</a>`}
    </div>
  </aside>`;
}

function PathRow({ label, path }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(path).then(() => setCopied(true), () => {});
  return html`<div class="path"><span class="grow"><small>${label}</small><span class="mono">${path}</span></span>
    <button class="btn sm" aria-label=${`${t("act.copy")}: ${label}`} onClick=${copy}><${Icon} name="copy" size=${16} />${t(copied ? "act.copied" : "act.copy")}</button></div>`;
}

/** A step's text as written, and — in a language other than English — a button that has flowd translate it. */
function Prompt({ step, text, head }) {
  const lang = getLang();
  const [tr, setTr] = useState(null); // null, "busy" or {text}
  const [show, setShow] = useState("tr");
  const [err, setErr] = useState(null);
  const translate = attempt(async () => {
    setTr("busy");
    try {
      setTr(await api("POST", `/api/steps/${enc(step)}/translate`, { lang }));
    } catch (e) {
      setTr(null);
      throw e;
    }
  }, setErr);
  const done = tr && tr !== "busy";
  const seg = (k, label) => html`<button class=${show === k ? "on" : ""} aria-pressed=${show === k} onClick=${() => setShow(k)}>${label}</button>`;
  return html`<div class="prompt">
    <div class="prow">${head && html`<h3 class="grow">${head}</h3>`}
      ${lang !== "en" && !tr && html`<button class="btn sm" onClick=${translate}><${Icon} name="translate" size=${18} />${t("read.translate")}</button>`}
      ${done && html`<div class="seg" role="group" aria-label=${t("read.textLang")}>${seg("tr", t("read.translation"))}${seg("orig", t("read.original"))}</div>`}
    </div>
    <${Err} msg=${err} />
    ${tr === "busy" && html`<p class="busy"><span class="spin" aria-hidden="true"></span>${t("read.translating")}</p>`}
    ${done && show === "tr" ? html`<pre class="instr tr">${tr.text}</pre><p class="small muted">${t("read.machine")}</p>` : html`<pre class="instr">${text}</pre>`}
  </div>`;
}

function StartForm({ arg: name }) {
  const { data: list, error } = useData("/api/processes", false);
  const { data: sessions } = useData("/api/sessions", false);
  const [bind, setBind] = useState({});
  const [err, setErr] = useState(null);
  if (!list) return html`<${Loading} error=${error} />`;
  const p = list.find((x) => x.name === name);
  if (!p) return html`<p class="err-box">${t("proc.missing", { name })}</p>`;
  const start = attempt(async () => {
    const r = await api("POST", "/api/runs", { process: name, bind: clean(bind) });
    go("run", r.run);
  }, setErr);
  return html`
    <a class="back small" href="#/process/${enc(name)}">← ${name}</a>
    <section class="head"><div><h1>${t("start.title", { name })}</h1>${p.description && html`<p class="lead">${p.description}</p>`}</div></section>
    ${p.roles.length > 0 && html`<div class="box form">${p.roles.map((role) => html`<label class="field">${t("start.who", { role })}
      <select value=${bind[role] || ""} onChange=${(e) => setBind({ ...bind, [role]: e.target.value })}>
        <option value="">${t("start.newTerminal")}</option>
        ${(sessions || []).map((s) => html`<option value=${s.id}>${sessionLabel(s)}</option>`)}
      </select></label>`)}</div>`}
    <${DefErrors} p=${p} />
    <${Err} msg=${err} />
    <div class="acts">${p.valid && html`<button class="btn primary" onClick=${start}>${t("act.start")}</button>`}
      <button class="btn quiet" onClick=${() => go("process", name)}>${t("act.cancel")}</button></div>`;
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
            <td>${p.name}<div class="muted src"><code>${p.source}</code></div></td>
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

const PAGES = { runs: Now, run: Run, processes: Processes, process: ProcessView, start: StartForm, steps: Steps, step: StepEditor, settings: Settings, plugins: Settings };
const TAB = { runs: "now", run: "now", processes: "processes", process: "processes", start: "processes", settings: "settings", plugins: "settings", steps: "settings", step: "settings" };
const NAV = [["now", "#/runs"], ["processes", "#/processes"], ["settings", "#/settings"]];

function pageTitle(page, arg, runs) {
  if (page === "run" && arg) {
    const r = (runs || []).find((x) => x.id === arg);
    return (r && runTitle(r)) || runLabel(arg);
  }
  if ((page === "process" || page === "start" || page === "step") && arg) return arg;
  return t(`nav.${TAB[page] || "now"}`);
}

function App() {
  const [page, arg, sub, rest] = useRoute();
  const [lang, setLangState] = useState(getLang());
  const [hidden, setHidden] = useState(savedHidden);
  const { data: openRuns } = useData("/api/runs");
  // the tab's count and the favicon follow the home screen: a hidden process's runs are not counted
  const waiting = (openRuns || []).filter((r) => r.needsYou && !hidden.has(r.process)).length;
  const onHidden = (set) => {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch { /* private window: the choice lasts this visit */ }
    setHidden(set);
  };
  const tab = TAB[page] || "now";
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = waiting > 0 ? t("title.waiting", { n: waiting }) : t("title.page", { page: pageTitle(page, arg, openRuns) });
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
    <main class="wrap page"><${Page} arg=${arg} sub=${sub} rest=${rest} lang=${lang} onLang=${onLang} hidden=${hidden} onHidden=${onHidden} key=${`${page}/${arg || ""}/${sub === "step" ? "" : sub || ""}`} /></main>`;
}

render(html`<${App} />`, document.getElementById("app"));

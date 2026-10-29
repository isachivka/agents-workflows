import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ordinal } from "./engine.ts";

const BASE = process.env.FLOWD_URL || `http://127.0.0.1:${process.env.FLOWD_PORT || 7420}`;

class CliError extends Error {}

/** a GitHub pull request or a GitLab merge request URL; ui/pr.js has the same rule */
const PR_URL = /^https?:\/\/\S+\/(pull|merge_requests)\/\d+/;
const SLACK_URL = /^https:\/\/[\w-]+\.slack\.com\/archives\//;
/** an issue's page in a tracker (Jira: …/browse/KEY-12); ui/pr.js has the same rule */
const ISSUE_URL = /^https?:\/\/\S+\/browse\/([A-Z][A-Z0-9]*-\d+)/;

const HELP = `flow — drive flows from an agent session or a terminal

  flow show                              this session's current step: instructions, event, vars
  flow done [--note T] [--evidence URL]  close it as done
  flow failed --note T                   close it as failed
  flow set key=value …                   run variables (URLs show as links in the UI)
  flow wait --note T [--human]           end your turn on purpose (no reminder until your next turn)
  flow say TEXT [--file PATH]            write to the run's conversation in the messenger (with a file)
  flow publish FILE                      serve a copy of a report under an unguessable link; prints it
  flow ask FILE --note T                 ask the person on a page (FILE: a form fragment); posts its link,
                                         waits for them; their answer is typed in here as JSON
  flow signal <type> [key=value …] [--run ID] [--outcome done|failed]
                                         emit an event; a type without a dot becomes signal.<type>
  flow start <process> [--bind role=SESSION …] [--var key=value …] [--inner <process|none> …]
                                         start a run; --var seeds its vars before the first step;
                                         --inner: the process for its inner step, then for that one's
  flow skip [RUN] --note T               skip the current step of RUN, or of this session's run
  flow reopen RUN --at ENTRY [--note T]  put an ended run back to work at ENTRY; its agents resume their
                                         conversations when the run next needs them
  flow ls [--all] [--process P] [--where k=v …]
                                         open runs (--all: finished ones too); filtered, exit 1 when none match
  flow check [name]                      validate FLOWS_HOME offline (all, or one process or step)
  flow done|failed --human --run ID --step ID
                                         close a step from your own terminal
  flow install                           launchd agent, agterm and Claude hooks, skills, PATH link
  flow daemon                            run flowd in the foreground

Inside a flow session the step is found from FLOW_SESSION (zmx) or AGTERM_SESSION_ID; elsewhere pass --run and --step.
FLOWD_URL overrides the daemon address (default http://127.0.0.1:7420).`;

interface Args {
  _: string[];
  note?: string;
  evidence?: string;
  run?: string;
  step?: string;
  outcome?: string;
  bind: string[];
  human: boolean;
  all: boolean;
  process?: string;
  where: string[];
  vars: string[];
  inner: string[];
  file?: string;
  at?: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], bind: [], human: false, all: false, where: [], vars: [], inner: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${x} needs a value`);
      return v;
    };
    if (x === "--note") a.note = value();
    else if (x === "--evidence") a.evidence = value();
    else if (x === "--file") a.file = value();
    else if (x === "--at") a.at = value();
    else if (x === "--run") a.run = value();
    else if (x === "--step") a.step = value();
    else if (x === "--outcome") a.outcome = value();
    else if (x === "--bind") a.bind.push(value());
    else if (x === "--var") a.vars.push(value());
    else if (x === "--inner") a.inner.push(value());
    else if (x === "--human") a.human = true;
    else if (x === "--all") a.all = true;
    else if (x === "--process") a.process = value();
    else if (x === "--where") a.where.push(value());
    else if (x.startsWith("--")) throw new CliError(`unknown option ${x}`);
    else a._.push(x);
  }
  return a;
}

function pairs(items: string[]): Record<string, string> {
  return Object.fromEntries(items.map((kv) => {
    const i = kv.indexOf("=");
    if (i < 1) throw new CliError(`expected key=value, got ${kv}`);
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError(`flowd is not running: launchctl kickstart gui/${process.getuid?.() ?? "$UID"}/local.flows`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(data.error ?? (Array.isArray(data.errors) ? data.errors.join("\n") : `HTTP ${res.status}`));
  return data;
}

async function hook(path: string, body: Record<string, unknown>): Promise<number> {
  try {
    await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2_000) });
  } catch {
    // flowd down or slow: a hook must stay silent and quick
  }
  return 0;
}

const out = (s: string) => { process.stdout.write(`${s}\n`); };
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** What a Claude Code hook gets on stdin; anything unreadable is no input. */
async function stdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const text = await new Promise<string>((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
    setTimeout(() => resolve(s), 1_000).unref();
  });
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** This agterm pane as flowd names it: the session id, `<id>:right` in its split pane. */
const agtermSession = () =>
  process.env.AGTERM_SESSION_ID ? `${process.env.AGTERM_SESSION_ID}${process.env.AGTERM_PANE === "right" ? ":right" : ""}` : "";

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "agterm-hook") {
    // the event on stdin says which pane set a status (a split pane runs an agent of its own)
    const event = await stdinJson();
    const pane = str((event.payload as Record<string, unknown> | undefined)?.pane);
    return hook("/agterm", { kind: process.env.AGT_EVENT_KIND, status: process.env.AGT_EVENT_STATUS, session: process.env.AGT_SESSION_ID, pane });
  }
  if (cmd === "claude-hook") {
    const event = rest[0];
    if (event === "compacted") return hook("/claude", { event, session: process.env.FLOW_SESSION || agtermSession() });
    // turn signals are for zmx sessions only: agterm reports an agterm session's turns itself
    if (!process.env.FLOW_SESSION) return 0;
    const input = await stdinJson();
    return hook("/claude", { event, session: process.env.FLOW_SESSION, claude: str(input.session_id), source: str(input.source) });
  }
  const session = process.env.FLOW_SESSION || agtermSession() || undefined;
  try {
    const a = parseArgs(rest);
    switch (cmd) {
      case "show": {
        const q = new URLSearchParams();
        if (a.run) q.set("run", a.run);
        if (a.step) q.set("entry", a.step);
        if (!a.run && session) q.set("session", session);
        out((await call("GET", `/api/show?${q}`)).text);
        return 0;
      }
      case "done":
      case "failed": {
        if (cmd === "failed" && !a.note) throw new CliError("flow failed needs --note saying what went wrong");
        await call("POST", "/api/report", { session, run: a.run, entry: a.step, outcome: cmd, note: a.note, evidence: a.evidence, human: a.human });
        out(`recorded ${cmd}${a.step ? ` for ${a.step}` : ""}`);
        return 0;
      }
      case "wait": {
        if (!a.note) throw new CliError("flow wait needs --note saying what you are waiting for");
        await call("POST", "/api/wait", { session, run: a.run, entry: a.step, note: a.note, human: a.human });
        out(`waiting: ${a.note}`);
        return 0;
      }
      case "say": {
        if (a._.length !== 1 || !a._[0].trim()) throw new CliError('usage: flow say "text" [--file PATH] [--run ID]');
        await call("POST", "/api/say", { session: a.run ? undefined : session, run: a.run, text: a._[0], file: a.file ? resolve(a.file) : undefined });
        out("sent");
        return 0;
      }
      case "ask": {
        if (a._.length !== 1 || !a.note) throw new CliError('usage: flow ask FILE --note "the question, in a line"');
        const r = await call("POST", "/api/ask", { session: a.run ? undefined : session, run: a.run, entry: a.step, file: resolve(a._[0]), note: a.note });
        if (r.chat) process.stderr.write(`flow: the link was not posted to the messenger: ${r.chat}\n`);
        out(r.url);
        return 0;
      }
      case "publish": {
        if (a._.length !== 1) throw new CliError("usage: flow publish FILE");
        out((await call("POST", "/api/publish", { file: resolve(a._[0]) })).url);
        return 0;
      }
      case "skip": {
        if (!a.note) throw new CliError("flow skip needs --note saying why");
        await call("POST", "/api/skip", { session: a._[0] ? undefined : session, run: a._[0] ?? a.run, note: a.note });
        out("skipped");
        return 0;
      }
      case "reopen": {
        if (a._.length !== 1 || !a.at) throw new CliError("usage: flow reopen RUN --at ENTRY [--note T]");
        await call("POST", `/api/runs/${encodeURIComponent(a._[0])}/reopen`, { entry: a.at, note: a.note });
        out(`${a._[0]} reopened at ${a.at}`);
        return 0;
      }
      case "set": {
        if (!a._.length) throw new CliError("usage: flow set key=value …");
        const vars = pairs(a._);
        await call("POST", "/api/vars", { session, run: a.run, vars });
        for (const [k, v] of Object.entries(vars)) {
          if (k !== "pr" && PR_URL.test(v)) process.stderr.write(`flow: hint: ${k} looks like a pull request — the standard name is pr (flow set pr=${v})\n`);
          if (k !== "slack_thread" && SLACK_URL.test(v)) process.stderr.write(`flow: hint: ${k} looks like a Slack thread — the standard name is slack_thread (flow set slack_thread=${v})\n`);
          const key = k === "issue_url" ? null : ISSUE_URL.exec(v)?.[1];
          if (key) process.stderr.write(`flow: hint: ${k} looks like an issue's page — the standard names are issue for its key and issue_url for the link (flow set issue=${key} issue_url=${v})\n`);
        }
        out("ok");
        return 0;
      }
      case "signal": {
        const [raw, ...kv] = a._;
        if (!raw) throw new CliError("usage: flow signal <type> [key=value …]");
        const type = raw.includes(".") ? raw : `signal.${raw}`;
        await call("POST", "/api/events", { type, run: a.run, outcome: a.outcome, data: pairs(kv) });
        out(`sent ${type}`);
        return 0;
      }
      case "start": {
        const [name] = a._;
        if (!name) throw new CliError("usage: flow start <process> [--bind role=SESSION …] [--var key=value …] [--inner <process|none> …]");
        const r = await call("POST", "/api/runs", { process: name, bind: pairs(a.bind), vars: pairs(a.vars), ...(a.inner.length ? { inner: a.inner } : {}) });
        // the id stays the first word: scripts read it
        out(r.nests ? `${r.nests.process} will run inside ${r.nests.in} when it reaches inner`
          : r.queued ? `${r.run} queued: ${ordinal(r.queued.position)} in line, ${r.queued.open} of ${r.queued.max} runs open` : r.run);
        return 0;
      }
      case "ls": {
        const where = Object.entries(pairs(a.where));
        const runs = (await call("GET", `/api/runs${a.all ? "?all=1" : ""}`)).filter((r: any) =>
          (!a.process || r.process === a.process) && where.every(([k, v]) => r.vars?.[k] === v));
        if (!runs.length) out("no runs");
        for (const r of runs) {
          out([r.id, `it.${r.iteration}`, r.status, r.queue ? `${ordinal(r.queue.position)} in line` : "", r.current ? `${r.current} (${r.currentStatus}${r.agentWait ? `, waiting: ${r.agentWait.note}` : ""})` : r.queue ? "" : "-",
            r.waitingOn ? `waits ${r.waitingOn}` : "", r.heldBy ? `waits hold ${r.heldBy.hold}${r.heldBy.run ? ` (${r.heldBy.run})` : ""}` : "", r.reason ?? "", r.parent ? `↳ ${r.parent}` : ""].filter(Boolean).join("  "));
        }
        // a filtered ls is a question a script asks: exit 1 is "no such run"
        return !runs.length && (a.process || where.length) ? 1 : 0;
      }
      case "check": {
        const { checkDefs } = await import("./check.ts");
        const { flowsHome } = await import("./defs.ts");
        const r = await checkDefs(flowsHome(), a._[0]);
        for (const line of r.lines) out(line);
        return r.ok ? 0 : 1;
      }
      case "install": {
        const { install } = await import("./install.ts");
        await install();
        return 0;
      }
      case "daemon": {
        const { startDaemon } = await import("./main.ts");
        await startDaemon();
        return -1;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(HELP);
        return 0;
      default:
        throw new CliError(`unknown command ${cmd} (flow help)`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`flow: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}

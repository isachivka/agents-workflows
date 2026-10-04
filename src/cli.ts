import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = process.env.FLOWD_URL || `http://127.0.0.1:${process.env.FLOWD_PORT || 7420}`;

class CliError extends Error {}

const HELP = `flow — drive flows from an agent session or a terminal

  flow show                              this session's current step: instructions, event, vars
  flow done [--note T] [--evidence URL]  close it as done
  flow failed --note T                   close it as failed
  flow set key=value …                   run variables (URLs show as links in the UI)
  flow signal <type> [key=value …] [--run ID] [--outcome done|failed]
                                         emit an event; a type without a dot becomes signal.<type>
  flow start <process> [--bind role=SESSION …]
  flow ls [--all]                        open runs (--all: finished ones too)
  flow check [name]                      validate FLOWS_HOME offline (all, or one process or step)
  flow done|failed --human --run ID --step ID
                                         close a step from your own terminal
  flow install                           launchd agent, agterm and Claude hooks, skills, PATH link
  flow daemon                            run flowd in the foreground

Inside a flow session the step is found from AGTERM_SESSION_ID; elsewhere pass --run and --step.
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
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], bind: [], human: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new CliError(`${x} needs a value`);
      return v;
    };
    if (x === "--note") a.note = value();
    else if (x === "--evidence") a.evidence = value();
    else if (x === "--run") a.run = value();
    else if (x === "--step") a.step = value();
    else if (x === "--outcome") a.outcome = value();
    else if (x === "--bind") a.bind.push(value());
    else if (x === "--human") a.human = true;
    else if (x === "--all") a.all = true;
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

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "agterm-hook") {
    return hook("/agterm", { kind: process.env.AGT_EVENT_KIND, status: process.env.AGT_EVENT_STATUS, session: process.env.AGT_SESSION_ID });
  }
  if (cmd === "claude-hook") return hook("/claude", { event: rest[0], session: process.env.AGTERM_SESSION_ID });
  const session = process.env.AGTERM_SESSION_ID || undefined;
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
      case "set": {
        if (!a._.length) throw new CliError("usage: flow set key=value …");
        await call("POST", "/api/vars", { session, run: a.run, vars: pairs(a._) });
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
        if (!name) throw new CliError("usage: flow start <process> [--bind role=SESSION …]");
        out((await call("POST", "/api/runs", { process: name, bind: pairs(a.bind) })).run);
        return 0;
      }
      case "ls": {
        const runs = await call("GET", `/api/runs${a.all ? "?all=1" : ""}`);
        if (!runs.length) out("no runs");
        for (const r of runs) {
          out([r.id, `it.${r.iteration}`, r.status, r.current ? `${r.current} (${r.currentStatus})` : "-",
            r.waitingOn ? `waits ${r.waitingOn}` : "", r.reason ?? ""].filter(Boolean).join("  "));
        }
        return 0;
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

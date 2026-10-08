import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realAgterm, shq } from "./agterm.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "local.flows";

/** retryMs: the pause between bootstrap attempts (tests shorten it) */
export interface InstallOpts { home?: string; repo?: string; node?: string; launchctl?: string; agtermctl?: string; uid?: number; log?: (s: string) => void; retryMs?: number }

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(node: string, cliPath: string, logPath: string, path: string, listen = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string>${listen ? `<key>FLOWD_HOST</key><string>${xml(listen)}</string>` : ""}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function link(target: string, at: string, say: (s: string) => void): void {
  mkdirSync(dirname(at), { recursive: true });
  if (existsSync(at) || lstatSync(at, { throwIfNoEntry: false })) {
    if (!lstatSync(at).isSymbolicLink()) {
      say(`skip ${at}: exists and is not a symlink`);
      return;
    }
    if (readlinkSync(at) === target) return;
    unlinkSync(at);
  }
  symlinkSync(target, at);
  say(`linked ${at} -> ${target}`);
}

function run(bin: string, args: string[], say: (s: string) => void): void {
  try {
    execFileSync(bin, args, { stdio: "pipe" });
  } catch (e) {
    say(`${bin} ${args.join(" ")}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

function defaultNode(): string {
  try {
    const found = execFileSync("/bin/sh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
    if (found) return found; // may carry a version (nvm): install replaces its own hooks on every run
  } catch {
    // fall back below
  }
  return process.execPath;
}

export async function install(o: InstallOpts = {}): Promise<void> {
  const home = o.home ?? homedir();
  const repo = o.repo ?? REPO;
  const node = o.node ?? defaultNode();
  const say = o.log ?? ((s: string) => console.log(s));
  const cli = join(repo, "src", "cli.ts");
  const flowCmd = `${shq(node)} ${shq(cli)}`;

  link(join(repo, "bin", "flow"), join(home, ".local", "bin", "flow"), say);

  const stateDir = join(home, ".local", "state", "flows");
  mkdirSync(stateDir, { recursive: true });
  const plistPath = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(dirname(plistPath), { recursive: true });
  const path = [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  // FLOWD_HOST from the environment, else kept from the old plist: a re-install must not quietly take flowd off the LAN
  const oldPlist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : "";
  // whitespace between key and value: plutil -insert puts them on lines of their own
  const listen = process.env.FLOWD_HOST || /<key>FLOWD_HOST<\/key>\s*<string>([^<]*)<\/string>/.exec(oldPlist)?.[1] || "";
  writeFileSync(plistPath, plist(node, cli, join(stateDir, "flowd.log"), path, listen));
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const launchctl = o.launchctl ?? process.env.FLOWS_LAUNCHCTL ?? "launchctl";
  run(launchctl, ["bootout", `gui/${uid}/${LABEL}`], () => {}); // not loaded yet is fine
  // bootout returns before launchd has let the old service go, and a bootstrap then fails
  // ("5: Input/output error"), leaving flowd down: try again for a few seconds
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(launchctl, ["bootstrap", `gui/${uid}`, plistPath], { stdio: "pipe" });
      break;
    } catch (e) {
      if (attempt === 10) {
        say(`${launchctl} bootstrap gui/${uid} ${plistPath}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, o.retryMs ?? 500);
    }
  }
  say(`launchd: ${plistPath} (log ${join(stateDir, "flowd.log")})`);

  const hooksPath = join(home, ".config", "agterm", "hooks.conf");
  mkdirSync(dirname(hooksPath), { recursive: true });
  // flows' own lines from an earlier install (possibly another node or repo path) are replaced
  const ours = (line: string) => /^on (status|session\.closed) .*cli\.ts' agterm-hook$/.test(line);
  const kept = (existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "").split("\n").filter((l) => !ours(l));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const hookLines = ["status", "session.closed"].map((kind) => `on ${kind} ${flowCmd} agterm-hook`);
  writeFileSync(hooksPath, `${[...kept, ...hookLines].join("\n")}\n`);
  try {
    await realAgterm(o.agtermctl).reloadHooks();
  } catch (e) {
    say(e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
  say(`agterm hooks: ${hooksPath}`);

  const settingsPath = join(home, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  // Turn signals matter only inside a zmx session flowd spawned ($FLOW_SESSION set): elsewhere the
  // shell skips node, so other Claude sessions pay nothing per tool call.
  const turn = (event: string) => `[ -z "$FLOW_SESSION" ] || ${flowCmd} claude-hook ${event}`;
  const wanted: [string, string, string?][] = [
    ["PostCompact", `${flowCmd} claude-hook compacted`],
    ["SessionStart", turn("start")],
    ["UserPromptSubmit", turn("active")],
    ["PostToolUse", turn("active")],
    ["Stop", turn("completed")],
    ["Notification", turn("blocked"), "permission_prompt"],
    ["Notification", turn("idle"), "idle_prompt"],
  ];
  const before = JSON.stringify(settings.hooks);
  const ourHook = (h: { command?: string }) => /cli\.ts' claude-hook \w+$/.test(h.command ?? "");
  // drop flows' entries from an earlier install (possibly another node or repo path), keep everyone else's
  for (const event of new Set(wanted.map(([e]) => e))) {
    settings.hooks[event] = (settings.hooks[event] ?? [])
      .map((g: { hooks?: { command?: string }[] }) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ourHook(h)) }))
      .filter((g: { hooks: unknown[] }) => g.hooks.length > 0);
  }
  for (const [event, command, matcher] of wanted) {
    settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
  }
  if (JSON.stringify(settings.hooks) !== before) {
    if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-flows`);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    say(`Claude hooks (${wanted.map(([e]) => e).join(", ")}) written to ${settingsPath} (backup: settings.json.bak-flows)`);
  }

  for (const skill of ["flow", "flow-author"]) link(join(repo, "skills", skill), join(home, ".claude", "skills", skill), say);
  say("done. UI: http://127.0.0.1:7420");
}

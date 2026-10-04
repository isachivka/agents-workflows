import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shq } from "./agterm.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "local.flows";

export interface InstallOpts { home?: string; repo?: string; node?: string; launchctl?: string; agtermctl?: string; uid?: number; log?: (s: string) => void }

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(node: string, cliPath: string, logPath: string, path: string): string {
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
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
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
    if (found) return found; // e.g. /opt/homebrew/bin/node — survives node upgrades, unlike the Cellar path
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
  writeFileSync(plistPath, plist(node, cli, join(stateDir, "flowd.log"), path));
  const uid = o.uid ?? process.getuid?.() ?? 501;
  const launchctl = o.launchctl ?? process.env.FLOWS_LAUNCHCTL ?? "launchctl";
  run(launchctl, ["bootout", `gui/${uid}/${LABEL}`], () => {}); // not loaded yet is fine
  run(launchctl, ["bootstrap", `gui/${uid}`, plistPath], say);
  say(`launchd: ${plistPath} (log ${join(stateDir, "flowd.log")})`);

  const hooksPath = join(home, ".config", "agterm", "hooks.conf");
  mkdirSync(dirname(hooksPath), { recursive: true });
  let hooks = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
  for (const kind of ["status", "session.closed"]) {
    const line = `on ${kind} ${flowCmd} agterm-hook`;
    if (!hooks.split("\n").includes(line)) hooks += `${hooks && !hooks.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(hooksPath, hooks);
  run(o.agtermctl ?? process.env.FLOWS_AGTERMCTL ?? "agtermctl", ["hooks", "reload"], say);
  say(`agterm hooks: ${hooksPath}`);

  const settingsPath = join(home, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const command = `${flowCmd} claude-hook compacted`;
  settings.hooks ??= {};
  settings.hooks.PostCompact ??= [];
  const present = JSON.stringify(settings.hooks.PostCompact).includes("claude-hook compacted");
  if (!present) {
    if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-flows`);
    settings.hooks.PostCompact.push({ hooks: [{ type: "command", command }] });
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    say(`Claude PostCompact hook added to ${settingsPath} (backup: settings.json.bak-flows)`);
  }

  link(join(repo, "skill", "flow"), join(home, ".claude", "skills", "flow"), say);
  say("done. UI: http://127.0.0.1:7420");
}

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionInfo { id: string; name: string; cwd: string; workspace: string; status?: string; title?: string }

export interface Agterm {
  spawn(o: { cwd: string; command: string; workspace: string; name: string }): Promise<string>;
  type(session: string, text: string): Promise<void>;
  focus(session: string): Promise<void>;
  tree(): Promise<SessionInfo[]>;
  reloadHooks(): Promise<void>;
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The spawned session runs `<spawn> '<prompt>'` inside a login shell, so claude is on PATH. */
export function spawnCommand(spawn: string, prompt: string, shell = "/bin/zsh -lc"): string {
  return `${shell} ${shq(`${spawn} ${shq(prompt)}`)}`;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function run(bin: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`agtermctl ${args.slice(0, 2).join(" ")}: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
    child.stdin?.end(stdin ?? "");
  });
}

/** `submitDelayMs`: pause between the text and its Enter, so the TUI has taken the text in. */
export function realAgterm(bin = process.env.FLOWS_AGTERMCTL || "agtermctl", submitDelayMs = 500): Agterm {
  return {
    async spawn(o) {
      const out = await run(bin, ["session", "new", "--cwd", o.cwd, "--command", o.command, "--workspace-name", o.workspace,
        "--create-workspace", "--no-select", "--name", o.name, "--json"]);
      const id = JSON.parse(out)?.result?.id;
      if (typeof id !== "string") throw new Error(`agtermctl session new: no id in ${out.slice(0, 200)}`);
      return id;
    },
    async type(session, text) {
      // Claude's composer takes a newline typed with the text, or passed as an argument, as text, not Enter.
      // So: the text, a pause, then Enter alone on stdin.
      // ponytail: fixed pause, no read-back; read the screen back with `session text` and retry if it still misses.
      const typeArgs = ["session", "type", "--stdin", "--target", session];
      await run(bin, typeArgs, text.replace(/\n$/, ""));
      await new Promise((r) => setTimeout(r, submitDelayMs));
      await run(bin, typeArgs, "\n");
    },
    async reloadHooks() {
      await run(bin, ["hooks", "reload"]);
    },
    async focus(session) {
      await run(bin, ["session", "select", "--target", session]);
    },
    async tree() {
      const out = JSON.parse(await run(bin, ["tree", "--json"]));
      const sessions: SessionInfo[] = [];
      for (const ws of out?.result?.tree?.workspaces ?? []) {
        for (const s of ws.sessions ?? []) {
          sessions.push({ id: s.id, name: s.name ?? "", cwd: s.cwd ?? "", workspace: ws.name ?? "", status: s.status, title: s.title });
        }
      }
      return sessions;
    },
  };
}

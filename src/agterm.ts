import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface SessionInfo { id: string; name: string; cwd: string; workspace: string; status?: string; title?: string; overlay?: boolean; surface?: string }

export interface SpawnOpts {
  cwd: string;
  /** the agent's command line (`agentLine`); the terminal runs it in a login zsh */
  command: string;
  workspace: string; name: string;
  /** set in the agent's environment (zmx; agterm sets its own) */
  env?: Record<string, string>;
  /** labels on the session (zmx) */
  labels?: Record<string, string>;
}

/** Where agents run: agterm, or zmx (src/zmx.ts). */
export interface Terminal {
  spawn(o: SpawnOpts): Promise<string>;
  type(session: string, text: string): Promise<void>;
  focus(session: string): Promise<void>;
  tree(): Promise<SessionInfo[]>;
  /** the session's screen as plain text */
  text(session: string): Promise<string>;
  /** raw keystrokes, no Enter added (e.g. `\x1b[B` for Down, `\r` for Enter) */
  press(session: string, keys: string): Promise<void>;
  /**
   * The user is typing in the session (the caret is past the prompt), or something covers it:
   * typing now would land on top. Cannot tell → false.
   */
  userInput(session: string): Promise<boolean>;
}

export interface Agterm extends Terminal {
  reloadHooks(): Promise<void>;
  /** zero-based caret column of a surface (`agtermctl surface cursor`) */
  cursorColumn(surface: string): Promise<number>;
}

/** The caret column at an empty input box: right after `❯ ` (Claude Code) or `› ` (Codex). */
export const EMPTY_INPUT_COLUMN = 2;

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The agent's command line: `<spawn> '<prompt>'`, the prompt one verbatim argument. */
export const agentLine = (spawn: string, prompt: string) => `${spawn} ${shq(prompt)}`;

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function run(bin: string, args: string[], stdin?: string, o: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 15_000, ...o }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${basename(bin)} ${args.slice(0, 2).join(" ")}: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
    // the CLI may exit before it reads its stdin: the pipe's EPIPE is then no news (the exit status
    // above says how it went), and unhandled it would kill flowd
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin ?? "");
  });
}

/**
 * `submitDelayMs`: pause between the text and its Enter, so the TUI has taken the text in.
 * `opener`: what brings agterm forward in macOS after a session is selected (`open -a agterm`).
 */
export function realAgterm(
  bin = process.env.FLOWS_AGTERMCTL || "agtermctl",
  submitDelayMs = 500,
  opener = process.env.FLOWS_OPEN || "open",
): Agterm {
  const a: Agterm = {
    async spawn(o) {
      // a login shell, so claude is on PATH
      const out = await run(bin, ["session", "new", "--cwd", o.cwd, "--command", `/bin/zsh -lc ${shq(o.command)}`, "--workspace-name", o.workspace,
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
      // selecting inside agterm leaves agterm behind the browser, often in another Space
      try {
        await run(opener, ["-a", process.env.FLOWS_AGTERM_APP || "agterm"]);
      } catch {
        // the session is selected; failing to raise the app is no reason to report an error
      }
    },
    async text(session) {
      return run(bin, ["session", "text", "--target", session]);
    },
    async press(session, keys) {
      await run(bin, ["session", "type", "--stdin", "--target", session], keys);
    },
    async cursorColumn(surface) {
      const column = Number(JSON.parse(await run(bin, ["surface", "cursor", "--target", surface, "--json"]))?.result?.cursor?.column);
      if (!Number.isInteger(column)) throw new Error(`agtermctl surface cursor: no column for ${surface}`);
      return column;
    },
    async tree() {
      const out = JSON.parse(await run(bin, ["tree", "--json"]));
      const sessions: SessionInfo[] = [];
      for (const ws of out?.result?.tree?.workspaces ?? []) {
        for (const s of ws.sessions ?? []) {
          sessions.push({ id: s.id, name: s.name ?? "", cwd: s.cwd ?? "", workspace: ws.name ?? "", status: s.status, title: s.title, overlay: s.overlay === true,
            surface: (s.surfaces ?? []).find((x: { kind?: string }) => x.kind === "left")?.id });
        }
      }
      return sessions;
    },
    // The caret, not the screen: Claude Code draws a greyed suggestion in an empty input box that
    // the screen text cannot tell from typed text.
    async userInput(session) {
      try {
        const info = (await a.tree()).find((s) => s.id === session);
        if (info?.overlay) return true;
        if (!info?.surface) return false;
        return (await a.cursorColumn(info.surface)) > EMPTY_INPUT_COLUMN;
      } catch {
        return false; // cannot tell: deliver as before
      }
    },
  };
  return a;
}

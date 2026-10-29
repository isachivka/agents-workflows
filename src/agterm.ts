import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface SessionInfo {
  id: string; name: string; cwd: string; workspace: string; status?: string; title?: string; overlay?: boolean; surface?: string;
  /** a split pane whose shell is at its prompt: a command typed now runs */
  atShell?: boolean;
}

export interface SpawnOpts {
  cwd: string;
  /** the role's spawn command (`claude …`), run in a login zsh with the prompt as its last argument */
  spawn: string;
  /** the agent's first prompt; empty: none (a resumed conversation) */
  prompt: string;
  workspace: string; name: string;
  /** the agterm window, by name, to spawn into instead of the frontmost one */
  window?: string;
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
  /** starts the agent in the split pane of `beside` (a session id) and returns `<beside>:right`; agterm only */
  spawnBeside?(o: SpawnOpts, beside: string): Promise<string>;
  /** closes the session and what runs in it (hibernate) */
  close?(session: string): Promise<void>;
}

export interface Agterm extends Terminal {
  spawnBeside(o: SpawnOpts, beside: string): Promise<string>;
  reloadHooks(): Promise<void>;
  /** zero-based caret column of a surface (`agtermctl surface cursor`) */
  cursorColumn(surface: string): Promise<number>;
}

/** The caret column at an empty input box: right after `❯ ` (Claude Code) or `› ` (Codex). */
export const EMPTY_INPUT_COLUMN = 2;

/** `<session>:right` is that agterm session's split pane; a bare id is its main pane. */
export const paneOf = (session: string): { id: string; pane: string[] } =>
  session.endsWith(":right") ? { id: session.slice(0, -":right".length), pane: ["--pane", "right"] } : { id: session, pane: [] };

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The agent's command line: `<spawn> '<prompt>'`, the prompt one verbatim argument. */
export const agentLine = (spawn: string, prompt: string) => (prompt ? `${spawn} ${shq(prompt)}` : spawn);

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
  pollMs = 200,
): Agterm {
  const windows = async (): Promise<{ id: string; name: string; open: boolean }[]> =>
    JSON.parse(await run(bin, ["window", "list", "--json"]))?.result?.windows ?? [];
  // one window per name, even when several spawns ask for it at once
  const making = new Map<string, Promise<string>>();
  const windowFor = (name: string): Promise<string> => {
    let p = making.get(name);
    if (!p) {
      p = (async () => {
        const all = await windows();
        const open = all.find((w) => w.name === name && w.open);
        if (open) return open.id;
        // a closed window's sessions went with it: a fresh one, minimized, never raised over the person's
        for (const w of all.filter((x) => x.name === name)) await run(bin, ["window", "delete", w.id]);
        const id = JSON.parse(await run(bin, ["window", "new", name, "--minimized", "--json"]))?.result?.id;
        if (typeof id !== "string") throw new Error(`agtermctl window new: no id for window ${name}`);
        return id;
      })().finally(() => making.delete(name));
      making.set(name, p);
    }
    return p;
  };
  /**
   * Without a window: the open window that already holds the workspace, so a spawn never lands in
   * whatever window is in front at that moment (a throwaway one a recorder opened and will delete).
   */
  const windowWithWorkspace = async (workspace: string): Promise<string[]> => {
    try {
      const open = (await windows()).filter((w) => w.open);
      if (open.length < 2) return [];
      for (const w of open) {
        const tree = JSON.parse(await run(bin, ["tree", "--json", "--window", w.id]));
        if ((tree?.result?.tree?.workspaces ?? []).some((ws: { name?: string }) => ws.name === workspace)) return ["--window", w.id];
      }
    } catch {
      // cannot tell: the frontmost window, as before
    }
    return [];
  };
  const a: Agterm = {
    async spawn(o) {
      const win = o.window ? ["--window", await windowFor(o.window)] : await windowWithWorkspace(o.workspace);
      // a login shell, so claude is on PATH
      const out = await run(bin, ["session", "new", ...win, "--cwd", o.cwd, "--command", `/bin/zsh -lc ${shq(agentLine(o.spawn, o.prompt))}`, "--workspace-name", o.workspace,
        "--create-workspace", "--no-select", "--name", o.name, "--json"]);
      const id = JSON.parse(out)?.result?.id;
      if (typeof id !== "string") throw new Error(`agtermctl session new: no id in ${out.slice(0, 200)}`);
      return id;
    },
    async spawnBeside(o, beside) {
      const pane = `${beside}:right`;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await run(bin, ["session", "split", "on", "--target", beside]);
      // the split's shell must be at its prompt, or the command lands in whatever runs there
      for (let i = 0; !(await a.tree()).find((s) => s.id === pane)?.atShell; i++) {
        if (i >= 50) throw new Error(`the split pane of ${beside} has no shell at its prompt (something else runs there)`);
        await sleep(pollMs);
      }
      // agterm counts a shell that is still starting as "at its shell": wait until its prompt is drawn
      // and still (typed earlier, the line landed ahead of the prompt; zsh read it, but a shell
      // that flushes typeahead would not)
      let last = "";
      for (let i = 0; ; i++) {
        const shown = (await a.text(pane)).trimEnd();
        if (shown && shown === last) break;
        if (i >= 50) throw new Error(`the shell in the split pane of ${beside} shows no settled prompt`);
        last = shown;
        await sleep(pollMs * 2);
      }
      // the split's shell is interactive, so the user's aliases apply there (a `codex` alias that adds
      // a flag the spawn has too stopped a live run): run it as a main-pane spawn does, in `zsh -lc`
      await a.type(pane, `cd ${shq(o.cwd)} && /bin/zsh -lc ${shq(agentLine(o.spawn, o.prompt))}`);
      // the agent is up once the pane no longer runs its shell
      for (let i = 0; (await a.tree()).find((s) => s.id === pane)?.atShell; i++) {
        if (i >= 50) throw new Error(`the agent did not start in the split pane of ${beside}: its shell is still at the prompt`);
        await sleep(pollMs);
      }
      return pane;
    },
    async type(session, text) {
      // Claude's composer takes a newline typed with the text, or passed as an argument, as text, not Enter.
      // So: the text, a pause, then Enter alone on stdin.
      // ponytail: fixed pause, no read-back; read the screen back with `session text` and retry if it still misses.
      const { id, pane } = paneOf(session);
      const typeArgs = ["session", "type", "--stdin", "--target", id, ...pane];
      const body = text.replace(/\n$/, "");
      await run(bin, typeArgs, body);
      await new Promise((r) => setTimeout(r, submitDelayMs));
      await run(bin, typeArgs, "\n");
      // several lines arrive as a paste, and Claude swallows the first Enter after a paste: while the
      // composer still holds the text, Enter again (an empty composer, a turn under way, takes none)
      if (!body.includes("\n")) return;
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, submitDelayMs));
        if (!(await a.userInput(session))) return;
        await run(bin, typeArgs, "\n");
      }
    },
    async reloadHooks() {
      await run(bin, ["hooks", "reload"]);
    },
    async close(session) {
      await run(bin, ["session", "close", "--target", paneOf(session).id]);
    },
    async focus(session) {
      const { id, pane } = paneOf(session);
      await run(bin, ["session", "select", "--target", id]);
      if (pane.length) await run(bin, ["session", "focus", "split", "--target", id]);
      // selecting inside agterm leaves agterm behind the browser, often in another Space
      try {
        await run(opener, ["-a", process.env.FLOWS_AGTERM_APP || "agterm"]);
      } catch {
        // the session is selected; failing to raise the app is no reason to report an error
      }
    },
    async text(session) {
      const { id, pane } = paneOf(session);
      // without --pane agterm reads the focused pane, which in a split may be the other agent's
      return run(bin, ["session", "text", "--target", id, ...(pane.length ? pane : ["--pane", "left"])]);
    },
    async press(session, keys) {
      const { id, pane } = paneOf(session);
      await run(bin, ["session", "type", "--stdin", "--target", id, ...pane], keys);
    },
    async cursorColumn(surface) {
      const column = Number(JSON.parse(await run(bin, ["surface", "cursor", "--target", surface, "--json"]))?.result?.cursor?.column);
      if (!Number.isInteger(column)) throw new Error(`agtermctl surface cursor: no column for ${surface}`);
      return column;
    },
    async tree() {
      // `tree` shows one window: with several open, each one's (sessions by id work across windows)
      let open: string[] = [];
      try {
        open = (await windows()).filter((w) => w.open).map((w) => w.id);
      } catch {
        // an agterm without window list: the frontmost window's tree
      }
      const outs = open.length > 1
        ? await Promise.all(open.map(async (id) => JSON.parse(await run(bin, ["tree", "--json", "--window", id]))))
        : [JSON.parse(await run(bin, ["tree", "--json"]))];
      const sessions: SessionInfo[] = [];
      for (const ws of outs.flatMap((out) => out?.result?.tree?.workspaces ?? [])) {
        for (const s of ws.sessions ?? []) {
          const surface = (kind: string) => (s.surfaces ?? []).find((x: { kind?: string }) => x.kind === kind)?.id;
          // the status belongs to the pane that set it (agterm's statusPane)
          const right = s.statusPane === "right";
          sessions.push({ id: s.id, name: s.name ?? "", cwd: s.cwd ?? "", workspace: ws.name ?? "", status: right ? undefined : s.status, title: s.title, overlay: s.overlay === true,
            surface: surface("left") });
          if (s.hasSplit) {
            sessions.push({ id: `${s.id}:right`, name: `${s.name ?? ""} (right)`, cwd: s.splitCwd ?? s.cwd ?? "", workspace: ws.name ?? "", status: right ? s.status : undefined,
              title: undefined, overlay: s.overlay === true || (s.paneOverlays ?? []).includes("right"), surface: surface("right"), atShell: Boolean(s.splitForegroundShell) });
          }
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

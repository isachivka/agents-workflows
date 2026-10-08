import { mkdirSync } from "node:fs";
import { EMPTY_INPUT_COLUMN, run, shq, type SessionInfo, type Terminal } from "./agterm.ts";

/** zmx takes only these characters in session names and label values. */
export const zmxName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * agterm's zmx (patched with `type` and `screen`) as a terminal: sessions run headless in their own
 * socket directory, never agterm's, whose `zmx prune` would kill them. Ids are `zmx:<name>`.
 */
export function zmxTerminal(o: { bin: string; dir: string; agtermctl?: string; opener?: string; submitDelayMs?: number }): Terminal {
  const zmx = (args: string[], stdin?: string, cwd?: string, env: Record<string, string> = {}) =>
    run(o.bin, args, stdin, { env: { ...process.env, ...env, ZMX_DIR: o.dir }, cwd });
  const nameOf = (session: string) => session.replace(/^zmx:/, "");
  const screen = async (session: string) => {
    const out = await zmx(["screen", nameOf(session)]);
    const nl = out.indexOf("\n");
    return { header: (nl < 0 ? out : out.slice(0, nl)).trim().split(/\s+/), text: nl < 0 ? "" : out.slice(nl + 1) };
  };
  return {
    async spawn(s) {
      const name = zmxName(s.name);
      mkdirSync(o.dir, { recursive: true });
      // zmx types the command into the session's shell, so only a fixed line goes that way: the
      // prompt (any text, newlines and tabs too) travels in the environment, which a new session
      // takes from the zmx that creates it. `exec` makes the agent the session's process, so the
      // session ends with it. FLOW_SESSION is how `flow` and the Claude hooks inside name the
      // session (ZMX_SESSION is set by agterm's own zmx panes too).
      await zmx(["run", name, "-d", "exec", "/bin/zsh", "-lc", `p=$FLOW_PROMPT; unset FLOW_PROMPT; exec ${s.spawn} "$p"`],
        undefined, s.cwd, { FLOW_SESSION: `zmx:${name}`, FLOW_PROMPT: s.prompt });
      const labels = Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${zmxName(v)}`);
      if (labels.length) await zmx(["set", name, ...labels]);
      return `zmx:${name}`;
    },
    async type(session, text) {
      // as with agterm: the text, a pause, then Return alone, or Claude takes the Return as pasted text
      await zmx(["type", nameOf(session)], text.replace(/\n$/, ""));
      await new Promise((r) => setTimeout(r, o.submitDelayMs ?? 500));
      await zmx(["type", nameOf(session)], "\r");
    },
    async press(session, keys) {
      await zmx(["send", nameOf(session), keys]);
    },
    async text(session) {
      return (await screen(session)).text;
    },
    async userInput(session) {
      try {
        // header: <revision> <cols> <rows> <cursorCol> <cursorRow> <n>
        return Number((await screen(session)).header[3]) > EMPTY_INPUT_COLUMN;
      } catch {
        return false; // cannot tell: deliver as before
      }
    },
    async tree() {
      const sessions: SessionInfo[] = [];
      for (const line of (await zmx(["list"])).split("\n")) {
        const f = Object.fromEntries(line.trim().split("\t").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
        if (!f.name) continue; // "no sessions found in …"
        const cwd = f.cwd?.startsWith("file://") ? decodeURIComponent(new URL(f.cwd).pathname) : (f.cwd ?? "");
        sessions.push({ id: `zmx:${f.name}`, name: f.name, cwd, workspace: "zmx" });
      }
      return sessions;
    },
    async focus(session) {
      const name = nameOf(session);
      // agterm runs the command inside its own zmx pane, whose ZMX_SESSION zmx attach would follow
      // instead of the name (checked live: "session agterm-… does not exist")
      const attach = `env -u ZMX_SESSION ZMX_DIR=${shq(o.dir)} ${shq(o.bin)} attach ${shq(name)}`;
      try {
        await run(o.agtermctl ?? "agtermctl", ["session", "new", "--command", attach, "--name", name]);
      } catch (e) {
        throw new Error(`agterm could not open ${name} (${e instanceof Error ? e.message : e}); attach in a terminal: ${attach}`);
      }
      try {
        await run(o.opener ?? "open", ["-a", process.env.FLOWS_AGTERM_APP || "agterm"]);
      } catch {
        // the session is open; failing to raise the app is no reason to report an error
      }
    },
  };
}

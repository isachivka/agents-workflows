import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Flowd, type FlowdOptions } from "../src/daemon.ts";
import type { Agterm, SessionInfo } from "../src/agterm.ts";

export class FakeAgterm implements Agterm {
  calls: string[] = [];
  sessions: SessionInfo[] = [];
  n = 0;
  failSpawn = 0;
  failType = 0;

  async spawn(o: { cwd: string; command: string; workspace: string; name: string }): Promise<string> {
    if (this.failSpawn > 0) { this.failSpawn--; throw new Error("no agterm"); }
    const id = `S${++this.n}`;
    this.calls.push(`spawn ${id} ${o.workspace} | ${o.name} | ${o.cwd} | ${o.command}`);
    this.sessions.push({ id, name: o.name, cwd: o.cwd, workspace: o.workspace });
    return id;
  }
  async type(session: string, text: string): Promise<void> {
    if (this.failType > 0) { this.failType--; throw new Error("session gone"); }
    this.calls.push(`type ${session} ${text}`);
  }
  async focus(session: string): Promise<void> { this.calls.push(`focus ${session}`); }
  async tree(): Promise<SessionInfo[]> { return this.sessions; }
  async reloadHooks(): Promise<void> { this.calls.push("hooks reload"); }
  typed(): string[] { return this.calls.filter((c) => c.startsWith("type ")); }
  addSession(...ids: string[]): this {
    for (const id of ids) this.sessions.push({ id, name: id, cwd: "/", workspace: "W" });
    return this;
  }
}

export const TEST_PLUGIN = `const g = globalThis as any;
export default {
  name: "test",
  events: ["ping"],
  watch(w: any, ctx: any) {
    if (!w.run) {
      if (w.with.fail) throw new Error("test cannot " + w.with.fail);
      (g.__flowsSubs ??= []).push(w);
      g.__flowsCtx = ctx;
      (g.__flowsCtxOf ??= new Map()).set(w, ctx);
      return () => { g.__flowsSubs = g.__flowsSubs.filter((x: any) => x !== w); };
    }
    (g.__flowsWatches ??= []).push(w.run + "/" + w.entry);
    return () => {};
  },
  actions: { post(args: any) { if (args.fail) throw new Error("post failed"); } },
};
`;
export const subs = (): any[] => ((globalThis as any).__flowsSubs ??= []);
export const pluginCtx = (): any => (globalThis as any).__flowsCtx;
/** The ctx the host gave one subscription: emitting through it is emitting as that subscription. */
export const ctxOf = (w: any): any => (globalThis as any).__flowsCtxOf?.get(w);
export const resetSubs = () => { (globalThis as any).__flowsSubs = []; };

export const STEP_FILES: Record<string, string> = {
  "steps/b.md": "---\nsummary: b\n---\nDo B for {{run.id}}\n",
  "steps/c.md": "---\nsummary: c\n---\nDo C\n",
};

export const proc = (steps: string, extra = "", name = "p"): Record<string, string> => ({
  [`processes/${name}.yaml`]: `description: d\ncwd: /tmp\n${extra}roles: {pm: {spawn: claude}}\nsteps:\n${steps}`,
});

export function makeHome(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "flows-home-"));
  for (const [rel, text] of Object.entries({ "plugins/test.ts": TEST_PLUGIN, ...files })) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}

export async function startFlowd(home: string, opts: Partial<FlowdOptions> = {}) {
  const clock = { t: 1_000_000 };
  const agterm = (opts.agterm as FakeAgterm | undefined) ?? new FakeAgterm();
  const f = new Flowd({
    home, statePath: join(home, "state.db"), agterm, pluginDirs: [join(home, "plugins")], now: () => clock.t,
    tickMs: 0, flushMs: 0, gapMs: 2_000, spawnGraceMs: 15_000, watchDefs: false, retryBaseMs: 10, log: () => {},
    claudeConfig: join(home, "no-claude.json"), // never the real ~/.claude.json
    ...opts,
  });
  await f.init();
  return { f, clock, agterm };
}

/** Lets queued events and deliveries run to a fixed point. */
export async function settle(f: Flowd): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await f.idle();
    await f.flush();
  }
  await f.idle();
}

export const watches = (): string[] => ((globalThis as any).__flowsWatches ??= []);
export const resetWatches = () => { (globalThis as any).__flowsWatches = []; };

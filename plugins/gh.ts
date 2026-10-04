import { execFile } from "node:child_process";
import type { Plugin } from "../src/plugins.ts";
import type { Dict } from "../src/types.ts";

export type Exec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function checksOutcome(rows: { name: string; bucket: string; link?: string }[]): { outcome: "done" | "failed"; data: Dict } | null {
  if (rows.some((r) => r.bucket === "pending")) return null;
  const failed = rows.filter((r) => r.bucket === "fail" || r.bucket === "cancel");
  return { outcome: failed.length ? "failed" : "done", data: { failed: failed.map((r) => r.name), links: failed.map((r) => r.link ?? "") } };
}

function json(out: { code: number; stdout: string; stderr: string }, what: string): unknown {
  try {
    return JSON.parse(out.stdout);
  } catch {
    throw new Error(`gh ${what}: ${out.stderr.trim() || `exit ${out.code}`}`);
  }
}

/** Polls in a row with no checks at all before a PR counts as having none (a fresh PR has not registered them yet). */
export const EMPTY_POLLS = 5;

export async function pollOnce(kind: "checks" | "merged" | "review", pr: string, exec: Exec, baseline?: string):
  Promise<{ emit?: { outcome?: "done" | "failed"; data: Dict }; baseline?: string }> {
  if (kind === "checks") {
    const out = await exec(["pr", "checks", pr, "--required", "--json", "name,bucket,link"]);
    const none = !out.stdout.trim() && /no required checks/i.test(out.stderr);
    const rows = none ? [] : json(out, "pr checks") as { name: string; bucket: string; link?: string }[];
    if (rows.length === 0) {
      // baseline counts the empty polls in a row
      const empty = Number(baseline ?? 0) + 1;
      if (empty < EMPTY_POLLS) return { baseline: String(empty) };
    }
    const result = checksOutcome(rows);
    return result ? { emit: result } : { baseline: "0" }; // checks exist: empty polls must start over
  }
  if (kind === "merged") {
    const { state } = json(await exec(["pr", "view", pr, "--json", "state"]), "pr view") as { state: string };
    if (state === "MERGED") return { emit: { outcome: "done", data: { state } } };
    if (state === "CLOSED") return { emit: { outcome: "failed", data: { state } } };
    return {};
  }
  const v = json(await exec(["pr", "view", pr, "--json", "reviews,comments"]), "pr view") as { reviews: unknown[]; comments: unknown[] };
  const now = `${v.reviews.length}/${v.comments.length}`;
  if (baseline === undefined || baseline === now) return { baseline: now };
  return { baseline: now, emit: { data: { reviews: v.reviews.length, comments: v.comments.length } } };
}

export function makeGhPlugin(exec: Exec = realExec, intervalMs = 60_000): Plugin {
  return {
    name: "gh",
    events: ["checks", "merged", "review"],
    watch(w, ctx) {
      const pr = String(w.with.pr ?? w.vars.pr ?? "");
      if (!pr) throw new Error("gh: no pr to watch (set vars.pr with `flow set pr=<url>`, or wait_for.with.pr)");
      const kind = w.type.slice("gh.".length) as "checks" | "merged" | "review";
      let baseline: string | undefined;
      let finished = false;
      const poll = async () => {
        if (finished) return;
        try {
          const r = await pollOnce(kind, pr, exec, baseline);
          baseline = r.baseline ?? baseline;
          if (r.emit && !finished) {
            finished = true;
            ctx.emit({ type: w.type, run: w.run, entry: w.entry, outcome: r.emit.outcome, data: { pr, ...r.emit.data } });
          }
        } catch (e) {
          ctx.error(e, w);
        }
      };
      void poll();
      const timer = setInterval(poll, Number(ctx.config.interval_ms ?? intervalMs));
      return () => {
        finished = true;
        clearInterval(timer);
      };
    },
  };
}

export default makeGhPlugin();

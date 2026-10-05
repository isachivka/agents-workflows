import { execFile } from "node:child_process";
import type { Plugin } from "../src/plugins.ts";
import type { Dict } from "../src/types.ts";

/** Runs gh with these args, in `cwd` when given (a repo-mode watch without with.repo uses the process cwd). */
export type Exec = (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const realExec: Exec = (args, cwd) =>
  new Promise((resolve) => {
    execFile("gh", args, { timeout: 30_000, cwd }, (err, stdout, stderr) => {
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

export async function pollOnce(kind: "checks" | "merged" | "review", pr: string, exec: Exec, baseline?: string, cwd?: string):
  Promise<{ emit?: { outcome?: "done" | "failed"; data: Dict }; baseline?: string }> {
  if (kind === "checks") {
    const out = await exec(["pr", "checks", pr, "--required", "--json", "name,bucket,link"], cwd);
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
    const { state } = json(await exec(["pr", "view", pr, "--json", "state"], cwd), "pr view") as { state: string };
    if (state === "MERGED") return { emit: { outcome: "done", data: { state } } };
    if (state === "CLOSED") return { emit: { outcome: "failed", data: { state } } };
    return {};
  }
  const v = json(await exec(["pr", "view", pr, "--json", "reviews,comments"], cwd), "pr view") as { reviews: unknown[]; comments: unknown[] };
  const now = `${v.reviews.length}/${v.comments.length}`;
  if (baseline === undefined || baseline === now) return { baseline: now };
  return { baseline: now, emit: { data: { reviews: v.reviews.length, comments: v.comments.length } } };
}

const PR_FIELDS = "number,url,title,headRefName,baseRefName,author,labels,createdAt,mergedAt";
const RUN_FIELDS = "databaseId,url,workflowName,conclusion,status,headSha,event,headBranch";

/** `at`: when it happened (merged PRs: mergedAt; open PRs: createdAt); used to tell new from old. */
type RepoItem = { id: string; at?: string; outcome: "done" | "failed"; data: Dict };

/** One repo-mode poll: merged or open PRs, or completed workflow runs, newest first as gh lists them. */
export async function pollRepo(kind: "merged" | "opened" | "ci", w: { with: Dict; cwd?: string }, exec: Exec): Promise<RepoItem[]> {
  const repo = w.with.repo ? ["--repo", String(w.with.repo)] : [];
  if (kind === "ci") {
    if (!w.with.branch) throw new Error("gh.ci needs with.branch");
    const args = ["run", "list", ...repo, "--branch", String(w.with.branch), "--limit", "30", "--json", RUN_FIELDS];
    if (w.with.workflow) args.push("--workflow", String(w.with.workflow));
    const rows = json(await exec(args, w.cwd), "run list") as Record<string, any>[];
    return rows.filter((r) => r.status === "completed").map((r) => ({
      id: String(r.databaseId), outcome: r.conclusion === "success" ? "done" : "failed",
      data: { run: r.url, id: r.databaseId, workflow: r.workflowName, conclusion: r.conclusion, branch: r.headBranch, sha: r.headSha, event: r.event },
    }));
  }
  // merged PRs sorted by update: a long-lived PR merged now is near the top, not 30 PRs down
  const state = kind === "merged" ? ["--state", "merged", "--search", "sort:updated-desc"] : ["--state", "open"];
  const args = ["pr", "list", ...repo, ...state, "--limit", "30", "--json", PR_FIELDS];
  if (w.with.base) args.push("--base", String(w.with.base));
  if (w.with.label) args.push("--label", String(w.with.label));
  const rows = json(await exec(args, w.cwd), "pr list") as Record<string, any>[];
  return rows.map((r) => ({
    id: String(r.number), at: kind === "merged" ? r.mergedAt : r.createdAt, outcome: "done",
    data: { pr: r.url, number: r.number, title: r.title, branch: r.headRefName, base: r.baseRefName, author: r.author?.login ?? "" },
  }));
}

export function makeGhPlugin(exec: Exec = realExec, intervalMs = 60_000): Plugin {
  return {
    name: "gh",
    events: ["checks", "merged", "review", "opened", "ci"],
    watch(w, ctx) {
      const kind = w.type.slice("gh.".length) as "checks" | "merged" | "review" | "opened" | "ci";
      const every = Number(ctx.config.interval_ms ?? intervalMs);
      if (!w.run && w.with.pr) throw new Error(`a trigger watches a repo, not one PR: drop with.pr from the ${w.type} trigger`);
      // PR mode: with.pr, or for a wait the run's vars.pr. Repo mode otherwise (gh.opened and gh.ci
      // always); a gh.merged wait needs a repo filter to mean "any merge", so a missing pr stays an error.
      const pr = String(w.with.pr ?? (w.run ? w.vars.pr ?? "" : ""));
      const repoFilter = ["repo", "base", "label"].some((k) => w.with[k] !== undefined);
      if (kind === "merged" && !pr && w.run && !repoFilter) {
        throw new Error("gh.merged needs a PR (vars.pr or with.pr), or with.repo, with.base or with.label to wait for any merge");
      }
      if (kind === "opened" || kind === "ci" || (kind === "merged" && !pr)) {
        if (kind === "ci" && !w.with.branch) throw new Error("gh.ci needs with.branch");
        // The first poll is the baseline: history never fires. A timed kind also needs a time after the
        // newest one seen, so an old item that slides into the 30-item window is not taken for new.
        const timed = kind === "merged" || (kind === "opened" && w.with.label === undefined);
        let seen: Set<string> | null = null;
        let mark = "";
        let finished = false;
        let failing = false;
        const poll = async () => {
          if (finished) return;
          try {
            const items = await pollRepo(kind, w, exec);
            if (finished) return;
            if (failing) { ctx.error(null, w); failing = false; } // working again: clear the error
            const newest = items.reduce((m, i) => (i.at && i.at > m ? i.at : m), mark);
            if (!seen) { seen = new Set(items.map((i) => i.id)); mark = newest; return; }
            const fresh = items.filter((i) => !seen!.has(i.id) && (!timed || (i.at !== undefined && i.at > mark)));
            fresh.sort((a, b) => (a.at && b.at ? a.at.localeCompare(b.at) : items.indexOf(b) - items.indexOf(a))); // oldest first
            for (const i of items) seen.add(i.id);
            mark = newest;
            for (const i of fresh) {
              ctx.emit({ type: w.type, run: w.run, entry: w.entry, outcome: i.outcome, data: i.data });
              if (w.run) { finished = true; return; } // a wait takes one event; a subscription keeps going
            }
          } catch (e) {
            failing = true;
            ctx.error(e, w);
          }
        };
        void poll();
        const timer = setInterval(poll, every);
        return () => {
          finished = true;
          clearInterval(timer);
        };
      }
      if (!pr) {
        throw new Error(kind === "checks"
          ? "gh.checks needs a PR (vars.pr or with.pr); to start on CI results use gh.ci"
          : `gh.${kind} needs a PR (vars.pr or with.pr)`);
      }
      const prKind = kind as "checks" | "merged" | "review";
      let baseline: string | undefined;
      let finished = false;
      let failing = false;
      const poll = async () => {
        if (finished) return;
        try {
          const r = await pollOnce(prKind, pr, exec, baseline, w.cwd);
          if (failing) { ctx.error(null, w); failing = false; } // working again: clear the error
          baseline = r.baseline ?? baseline;
          if (r.emit && !finished) {
            finished = true;
            ctx.emit({ type: w.type, run: w.run, entry: w.entry, outcome: r.emit.outcome, data: { pr, ...r.emit.data } });
          }
        } catch (e) {
          failing = true;
          ctx.error(e, w);
        }
      };
      void poll();
      const timer = setInterval(poll, every);
      return () => {
        finished = true;
        clearInterval(timer);
      };
    },
  };
}

export default makeGhPlugin();

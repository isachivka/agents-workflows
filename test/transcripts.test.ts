import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaudeSession } from "../src/transcripts.ts";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (sessionId: string, cwd: string, at: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", sessionId, cwd, timestamp: at, message: { role: "user", content }, ...extra });

function root(files: Record<string, string[]>, mtime = Date.now()): string {
  const dir = mkdtempSync(join(tmpdir(), "flows-claude-"));
  for (const [rel, lines] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), lines.join("\n") + "\n");
    utimesSync(join(dir, rel), mtime / 1000, mtime / 1000);
  }
  return dir;
}

test("finds the role's latest Claude session from the step lines flowd typed into it", async () => {
  const dir = root({
    "-w-repo/a1.jsonl": [user("a1", "/w/repo", "2026-10-01T10:00:00Z", "▶ flow: step build · jsf-pr#7 it.1 — run `flow show` for the instructions")],
    // after /clear the same agent goes on in a new file
    "-w-repo/a2.jsonl": [user("a2", "/w/repo", "2026-10-01T12:00:00Z", [{ type: "text", text: "▶ flow: step fix · jsf-pr#7 it.1 — run `flow show` for the instructions" }])],
    // another role of the same run
    "-w-repo/b1.jsonl": [user("b1", "/w/repo", "2026-10-01T13:00:00Z", "▶ flow: step review · jsf-pr#7 it.1 — run `flow show`")],
    // a run whose id starts the same
    "-w-repo/c1.jsonl": [user("c1", "/w/repo", "2026-10-01T14:00:00Z", "▶ flow: step build · jsf-pr#70 it.1 — run `flow show`")],
    // the line quoted back in a tool result, or by a subagent, is not the agent being told
    "-w-other/d1.jsonl": [
      user("d1", "/w/other", "2026-10-01T15:00:00Z", [{ type: "tool_result", content: "▶ flow: step build · jsf-pr#7 it.1" }]),
      user("d1", "/w/other", "2026-10-01T15:00:01Z", "▶ flow: step build · jsf-pr#7 it.1", { isSidechain: true }),
    ],
  });
  assert.deepEqual(await findClaudeSession(dir, "jsf-pr#7", ["build", "fix"], 0), { id: "a2", cwd: "/w/repo", at: Date.parse("2026-10-01T12:00:00Z") });
  assert.equal((await findClaudeSession(dir, "jsf-pr#7", ["review"], 0))?.id, "b1");
  assert.equal(await findClaudeSession(dir, "jsf-pr#7", ["deploy"], 0), null);
});

test("skips transcripts last written before the run started, and a missing root", async () => {
  const old = Date.parse("2026-09-01T00:00:00Z");
  const dir = root({ "-w/a.jsonl": [user("a", "/w", "2026-09-01T00:00:00Z", "▶ flow: step build · p#1 it.1")] }, old);
  assert.equal(await findClaudeSession(dir, "p#1", ["build"], old + 60_000), null);
  assert.equal((await findClaudeSession(dir, "p#1", ["build"], old - 60_000))?.id, "a");
  assert.equal(await findClaudeSession(join(dir, "nope"), "p#1", ["build"], 0), null);
});

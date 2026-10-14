import { test } from "node:test";
import assert from "node:assert/strict";
import { agentOf, skillRefs } from "../src/skills.ts";

test("a role's agent is told by its spawn command", () => {
  assert.equal(agentOf("claude --dangerously-skip-permissions"), "claude");
  assert.equal(agentOf("/opt/bin/codex --yolo"), "codex");
  assert.equal(agentOf("aider"), "other");
});

test("skills are named the way the agent loads them: /name, $name for Codex", () => {
  assert.deepEqual(skillRefs(["deliver", "bos:peer-chat"], "claude"), ["/deliver", "/bos:peer-chat"]);
  assert.deepEqual(skillRefs(["deliver", "bos:peer-chat"], "codex"), ["$deliver", "$bos:peer-chat"]);
  assert.deepEqual(skillRefs(["deliver"], "other"), ["/deliver"]);
});

test("a Codex agent always gets $flow, so it knows how to report, then the step's skills", async () => {
  const { lineSkills } = await import("../src/skills.ts");
  assert.deepEqual(lineSkills(["deliver"], "codex"), ["$flow", "$deliver"]);
  assert.deepEqual(lineSkills([], "codex"), ["$flow"]);
  assert.deepEqual(lineSkills(["flow"], "codex"), ["$flow"]);
  assert.deepEqual(lineSkills([], "claude"), []);
  assert.deepEqual(lineSkills(["deliver"], "claude"), ["/deliver"]);
});

test("Codex runs without the shared daemon, whose environment belongs to another session", async () => {
  const { agentSpawn } = await import("../src/skills.ts");
  assert.equal(agentSpawn("codex --yolo"), "codex --no-daemon --yolo");
  assert.equal(agentSpawn("/opt/bin/codex"), "/opt/bin/codex --no-daemon");
  assert.equal(agentSpawn("codex --no-daemon -m x"), "codex --no-daemon -m x");
  assert.equal(agentSpawn("claude --x"), "claude --x");
});

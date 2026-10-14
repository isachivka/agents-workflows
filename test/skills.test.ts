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

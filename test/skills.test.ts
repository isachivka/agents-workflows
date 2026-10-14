import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOf, skillRefs } from "../src/skills.ts";

function put(root: string, rel: string): string {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), "---\nname: x\n---\nbody\n");
  return join(root, rel);
}

test("a role's agent is told by its spawn command", () => {
  assert.equal(agentOf("claude --dangerously-skip-permissions"), "claude");
  assert.equal(agentOf("/opt/bin/codex --yolo"), "codex");
  assert.equal(agentOf("aider"), "other");
});

test("Claude gets the skill files attached: project, then user, then plugin; /name when none is found", () => {
  const t = mkdtempSync(join(tmpdir(), "flows-skills-"));
  const cwd = join(t, "repo"), claude = join(t, "claude");
  const deliver = put(cwd, ".claude/skills/deliver/SKILL.md");
  put(claude, "skills/deliver/SKILL.md"); // the project's wins
  const aqa = put(cwd, ".claude/commands/aqa.md");
  const mine = put(claude, "skills/notes/SKILL.md");
  const chat = put(t, "cache/bos/1.2.0/skills/peer-chat/SKILL.md");
  put(claude, "plugins/installed_plugins.json");
  writeFileSync(join(claude, "plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "bos@market": [{ installPath: join(t, "cache/bos/1.2.0") }] } }));
  assert.deepEqual(skillRefs(["deliver", "aqa", "notes", "bos:peer-chat", "nope", "other:x"], "claude", cwd, claude),
    [`@${deliver}`, `@${aqa}`, `@${mine}`, `@${chat}`, "/nope", "/other:x"]);
});

test("Codex gets $name; another agent gets /name", () => {
  assert.deepEqual(skillRefs(["deliver", "bos:peer-chat"], "codex", "/x", "/y"), ["$deliver", "$bos:peer-chat"]);
  assert.deepEqual(skillRefs(["deliver"], "other", "/x", "/y"), ["/deliver"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realAgterm, shq, spawnCommand, expandHome } from "../src/agterm.ts";

function fakeAgtermctl() {
  const dir = mkdtempSync(join(tmpdir(), "flows-agterm-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "agtermctl");
  writeFileSync(bin, `#!/bin/sh
for a in "$@"; do printf '[%s]' "$a" >> '${log}'; done; echo >> '${log}'
if [ -n "$FAKE_FAIL" ]; then echo boom >&2; exit 3; fi
case "$1 $2" in
  "session new") echo '{"ok":true,"result":{"id":"S-NEW"}}' ;;
  "tree --json") echo '{"ok":true,"result":{"tree":{"workspaces":[{"name":"W","sessions":[{"id":"S1","name":"one","cwd":"/x","status":"active","title":"t"},{"id":"S2","name":"two","cwd":"/y"}]}]}}}' ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8") };
}

test("spawn passes every flag and returns the new session id", async () => {
  const f = fakeAgtermctl();
  const id = await realAgterm(f.bin).spawn({ cwd: "/w", command: "cmd", workspace: "ts-wave", name: "ts-wave#1 pm" });
  assert.equal(id, "S-NEW");
  assert.equal(f.calls(), "[session][new][--cwd][/w][--command][cmd][--workspace-name][ts-wave][--create-workspace][--no-select][--name][ts-wave#1 pm][--json]\n");
});

// A long line typed together with its newline lands in Claude's composer unsubmitted
// (seen live on 2026-10-04), so the text and the Enter are separate calls.
test("type sends the text, then Enter on its own; focus selects", async () => {
  const f = fakeAgtermctl();
  const a = realAgterm(f.bin, 0);
  await a.type("S1", "hi");
  await a.type("S1", "/clear\n");
  await a.focus("S1");
  assert.equal(f.calls(), "[session][type][--target][S1][hi]\n[session][type][--target][S1][\n]\n"
    + "[session][type][--target][S1][/clear]\n[session][type][--target][S1][\n]\n[session][select][--target][S1]\n");
});

test("tree flattens workspaces into sessions", async () => {
  const f = fakeAgtermctl();
  assert.deepEqual(await realAgterm(f.bin).tree(), [
    { id: "S1", name: "one", cwd: "/x", workspace: "W", status: "active", title: "t" },
    { id: "S2", name: "two", cwd: "/y", workspace: "W", status: undefined, title: undefined },
  ]);
});

test("a failing agtermctl rejects with its stderr", async () => {
  const f = fakeAgtermctl();
  process.env.FAKE_FAIL = "1";
  try {
    await assert.rejects(realAgterm(f.bin).type("S1", "x"), /agtermctl session type: boom/);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

const NASTY = `it's \`flow show\` "now" $HOME ▶ \\n end`;

test("shq survives quotes, backticks, dollars and backslashes", () => {
  assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${shq(NASTY)}`], { encoding: "utf8" }), NASTY);
});

test("spawnCommand hands the prompt to the agent as one verbatim argument", () => {
  const cmd = spawnCommand("printf [%s]", NASTY, "/bin/sh -c");
  assert.equal(execFileSync("/bin/sh", ["-c", cmd], { encoding: "utf8" }), `[${NASTY}]`);
  assert.ok(spawnCommand("claude", "x").startsWith("/bin/zsh -lc '"));
});

test("expandHome", () => {
  assert.equal(expandHome("~/a", "/h"), "/h/a");
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("/abs", "/h"), "/abs");
});

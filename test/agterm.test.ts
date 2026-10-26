import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realAgterm, shq, agentLine, expandHome } from "../src/agterm.ts";

function fakeAgtermctl() {
  const dir = mkdtempSync(join(tmpdir(), "flows-agterm-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "agtermctl");
  writeFileSync(bin, `#!/bin/sh
for a in "$@"; do printf '[%s]' "$a" >> '${log}'; done
case " $* " in *" --stdin "*) printf '<' >> '${log}'; cat >> '${log}'; printf '>' >> '${log}' ;; esac
echo >> '${log}'
if [ -n "$FAKE_FAIL" ]; then echo boom >&2; exit 3; fi
# the split's shell runs a program once a command was typed into it (unless FAKE_STUCK)
case " $* " in *" --pane right "*) [ "$1 $2" = "session type" ] && [ -z "$FAKE_STUCK" ] && tail -c 200 '${log}' | grep -q 'zsh -lc' && touch '${dir}/started' ;; esac
shell='"splitForegroundShell":"zsh",'; [ -f '${dir}/started' ] && shell=''
case "$1 $2" in
  "window list") printf '%s' "$FAKE_WINDOWS" ;;
  "window new") echo '{"ok":true,"result":{"id":"W-NEW"}}' ;;
  "session text") echo '➜ ~' ;;
  "session new") echo '{"ok":true,"result":{"id":"S-NEW"}}' ;;
  "surface cursor") echo '{"ok":true,"result":{"id":"surface:S1:left","cursor":{"column":7}}}' ;;
  "tree --json") echo '{"ok":true,"result":{"tree":{"workspaces":[{"name":"W","sessions":[{"id":"S1","name":"one","cwd":"/x","status":"active","title":"t","surfaces":[{"id":"surface:S1:right","kind":"right"},{"id":"surface:S1:left","kind":"left"}]},{"id":"S2","name":"two","cwd":"/y"},{"id":"S3","name":"three","cwd":"/z","status":"active","statusPane":"right","hasSplit":true,'"$shell"'"surfaces":[{"id":"surface:S3:left","kind":"left"},{"id":"surface:S3:right","kind":"right"}]}]}]}}}' ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8") };
}

test("spawn passes every flag, runs the command in a login zsh and returns the new session id", async () => {
  const f = fakeAgtermctl();
  const id = await realAgterm(f.bin).spawn({ cwd: "/w", spawn: "claude", prompt: "x", workspace: "pr-loop", name: "pr-loop#1 pm" });
  assert.equal(id, "S-NEW");
  // first: which open window holds the workspace (one window or none listed: the frontmost)
  assert.equal(f.calls(), `[window][list][--json]\n[session][new][--cwd][/w][--command][/bin/zsh -lc 'claude '\\''x'\\'''][--workspace-name][pr-loop][--create-workspace][--no-select][--name][pr-loop#1 pm][--json]\n`);
});

// Live on 2026-10-04: a line typed together with its newline landed in Claude's composer
// unsubmitted, and a newline passed as an argument did not submit either; Enter on stdin did.
test("type sends the text, then Enter on its own, both on stdin; focus selects and raises agterm", async () => {
  const f = fakeAgtermctl();
  const a = realAgterm(f.bin, 0, f.bin); // the fake also stands in for `open`
  await a.type("S1", "it's `x` $HOME");
  await a.type("S1", "/clear\n");
  await a.focus("S1");
  const T = "[session][type][--stdin][--target][S1]";
  assert.equal(f.calls(), `${T}<it's \`x\` $HOME>\n${T}<\n>\n${T}</clear>\n${T}<\n>\n[session][select][--target][S1]\n[-a][agterm]\n`);
});

test("a spawn with a window goes into the open window of that name, else a new minimized one (a closed one is deleted)", async () => {
  const f = fakeAgtermctl();
  const list = (ws: unknown[]) => JSON.stringify({ ok: true, result: { windows: ws } });
  process.env.FAKE_WINDOWS = list([{ id: "W1", name: "window 1", open: true }, { id: "WOLD", name: "Reels", open: false }]);
  try {
    const a = realAgterm(f.bin);
    // two spawns at once make one window
    await Promise.all([1, 2].map((i) => a.spawn({ cwd: "/w", spawn: "claude", prompt: "x", workspace: "Reels", window: "Reels", name: `reel ${i}` })));
    const calls = f.calls().trim().split("\n");
    assert.deepEqual(calls.slice(0, 3), ["[window][list][--json]", "[window][delete][WOLD]", "[window][new][Reels][--minimized][--json]"]);
    assert.equal(calls.filter((c) => c.startsWith("[window]")).length, 3);
    assert.ok(calls.slice(3).every((c) => c.startsWith("[session][new][--window][W-NEW][--cwd][/w]")), calls.join("\n"));
    process.env.FAKE_WINDOWS = list([{ id: "W1", name: "window 1", open: true }, { id: "W2", name: "Reels", open: true }]);
    const g = fakeAgtermctl();
    await realAgterm(g.bin).spawn({ cwd: "/w", spawn: "claude", prompt: "x", workspace: "Reels", window: "Reels", name: "reel 3" });
    assert.deepEqual(g.calls().trim().split("\n").map((c) => c.slice(0, 39)), ["[window][list][--json]", "[session][new][--window][W2][--cwd][/w]"]);
  } finally {
    delete process.env.FAKE_WINDOWS;
  }
});

test("without a window, a spawn goes to the open window that holds its workspace, not the frontmost", async () => {
  const f = fakeAgtermctl();
  // the fake answers every window's tree with workspace W
  process.env.FAKE_WINDOWS = JSON.stringify({ ok: true, result: { windows: [{ id: "REC", name: "reels", open: true }, { id: "W1", name: "window 1", open: true }] } });
  try {
    await realAgterm(f.bin).spawn({ cwd: "/w", spawn: "claude", prompt: "x", workspace: "W", name: "one" });
    await realAgterm(f.bin).spawn({ cwd: "/w", spawn: "claude", prompt: "x", workspace: "Elsewhere", name: "two" });
    const calls = f.calls().trim().split("\n");
    assert.ok(calls.some((c) => c.startsWith("[session][new][--window][REC][--cwd]")), calls.join("\n"));
    assert.ok(calls.some((c) => c.startsWith("[session][new][--cwd]") && c.includes("[two]")), calls.join("\n"));
  } finally {
    delete process.env.FAKE_WINDOWS;
  }
});

test("with several open windows, tree reads each one's", async () => {
  const f = fakeAgtermctl();
  process.env.FAKE_WINDOWS = JSON.stringify({ ok: true, result: { windows: [{ id: "W1", open: true }, { id: "W2", open: true }, { id: "W3", open: false }] } });
  try {
    const sessions = await realAgterm(f.bin).tree();
    assert.equal(sessions.filter((s) => s.id === "S1").length, 2); // the fake answers the same tree for each
    assert.deepEqual(f.calls().trim().split("\n"), ["[window][list][--json]", "[tree][--json][--window][W1]", "[tree][--json][--window][W2]"]);
  } finally {
    delete process.env.FAKE_WINDOWS;
  }
});

test("tree flattens workspaces into sessions", async () => {
  const f = fakeAgtermctl();
  assert.deepEqual(await realAgterm(f.bin).tree(), [
    { id: "S1", name: "one", cwd: "/x", workspace: "W", status: "active", title: "t", overlay: false, surface: "surface:S1:left" },
    { id: "S2", name: "two", cwd: "/y", workspace: "W", status: undefined, title: undefined, overlay: false, surface: undefined },
    { id: "S3", name: "three", cwd: "/z", workspace: "W", status: undefined, title: undefined, overlay: false, surface: "surface:S3:left" },
    // the split pane is a session of its own, `<id>:right`, with the status agterm says is its
    { id: "S3:right", name: "three (right)", cwd: "/z", workspace: "W", status: "active", title: undefined, overlay: false, surface: "surface:S3:right", atShell: true },
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

test("agentLine hands the prompt to the agent as one verbatim argument", () => {
  assert.equal(execFileSync("/bin/sh", ["-c", agentLine("printf [%s]", NASTY)], { encoding: "utf8" }), `[${NASTY}]`);
});

test("expandHome", () => {
  assert.equal(expandHome("~/a", "/h"), "/h/a");
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("/abs", "/h"), "/abs");
});

test("cursorColumn reads a surface's caret column", async () => {
  const f = fakeAgtermctl();
  assert.equal(await realAgterm(f.bin).cursorColumn("surface:S1:left"), 7);
  assert.match(f.calls(), /\[surface\]\[cursor\]\[--target\]\[surface:S1:left\]\[--json\]/);
});

test("agtermctl exiting before it reads its stdin (EPIPE) is no crash", async () => {
  // `true` never reads stdin; a big write hits a closed pipe
  await realAgterm("/usr/bin/true", 0).press("S1", "x".repeat(4_000_000));
  await realAgterm("/usr/bin/true", 0).type("S1", "y".repeat(4_000_000));
});

test("userInput: the caret past the prompt is the user typing; no surface or an error reads as not", async () => {
  const f = fakeAgtermctl();
  assert.equal(await realAgterm(f.bin).userInput("S1"), true); // column 7
  assert.equal(await realAgterm(f.bin).userInput("S2"), false); // no left surface
  process.env.FAKE_FAIL = "1";
  try {
    assert.equal(await realAgterm(f.bin).userInput("S1"), false);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test("a split pane is addressed as <session>:right: typing, reading, keys and focus go to that pane", async () => {
  const f = fakeAgtermctl();
  const a = realAgterm(f.bin, 0, f.bin);
  await a.type("S3:right", "hi");
  await a.press("S3:right", "\r");
  await a.text("S3:right");
  await a.focus("S3:right");
  const T = "[session][type][--stdin][--target][S3][--pane][right]";
  assert.equal(f.calls(), `${T}<hi>\n${T}<\n>\n${T}<\r>\n[session][text][--target][S3][--pane][right]\n[session][select][--target][S3]\n[session][focus][split][--target][S3]\n[-a][agterm]\n`);
});

test("spawnBeside opens the split, waits for its settled prompt, types the agent's command, sees it start", async () => {
  const f = fakeAgtermctl();
  const id = await realAgterm(f.bin, 0, f.bin, 1).spawnBeside({ cwd: "/w", spawn: "codex", prompt: "x", workspace: "W", name: "n" }, "S3");
  assert.equal(id, "S3:right");
  const T = "[session][type][--stdin][--target][S3][--pane][right]";
  const calls = f.calls().split("\n").filter(Boolean);
  assert.equal(calls[0], "[session][split][on][--target][S3]");
  // the prompt is read twice, the same both times, before anything is typed
  const typed = calls.indexOf(`${T}<cd '/w' && /bin/zsh -lc 'codex '\\''x'\\'''>`);
  assert.ok(typed > 0, calls.join("\n"));
  assert.equal(calls.slice(0, typed).filter((c) => c === "[session][text][--target][S3][--pane][right]").length, 2);
  assert.equal(calls[typed + 1], `${T}<`);
  assert.equal(calls.at(-1), "[tree][--json]");
});

test("spawnBeside fails when the agent never starts in the split", async () => {
  const f = fakeAgtermctl();
  process.env.FAKE_STUCK = "1";
  try {
    await assert.rejects(realAgterm(f.bin, 0, f.bin, 1).spawnBeside({ cwd: "/w", spawn: "codex", prompt: "x", workspace: "W", name: "n" }, "S3"),
      /the agent did not start in the split pane of S3/);
  } finally {
    delete process.env.FAKE_STUCK;
  }
});

// Seen live: a split session's main pane read without --pane gave the focused split's screen.
test("text of a main pane names the pane: agterm would read whichever pane has focus", async () => {
  const f = fakeAgtermctl();
  await realAgterm(f.bin).text("S1");
  assert.equal(f.calls(), "[session][text][--target][S1][--pane][left]\n");
});

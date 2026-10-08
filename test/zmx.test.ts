import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zmxTerminal } from "../src/zmx.ts";

/** A fake `zmx`: logs `$ZMX_DIR|$PWD|[arg]…<stdin>` per call, answers `list` and `screen` from files. */
function fakeZmx() {
  const dir = mkdtempSync(join(tmpdir(), "flows-zmx-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "zmx");
  writeFileSync(join(dir, "list"), "no sessions found in /x\n");
  writeFileSync(join(dir, "screen"), "44 120 24 2 10 0\n❯ \nline two\n");
  writeFileSync(bin, `#!/bin/sh
printf '%s|%s|' "$ZMX_DIR" "$PWD" >> '${log}'
[ -n "$FLOW_SESSION" ] && printf '{%s}{%s}' "$FLOW_SESSION" "$FLOW_PROMPT" >> '${log}'
for a in "$@"; do printf '[%s]' "$a" >> '${log}'; done
if [ "$1" = type ]; then printf '<' >> '${log}'; cat >> '${log}'; printf '>' >> '${log}'; fi
echo >> '${log}'
if [ -n "$FAKE_FAIL" ]; then echo boom >&2; exit 3; fi
case "$1" in
  list) cat '${join(dir, "list")}' ;;
  screen) cat '${join(dir, "screen")}' ;;
esac
`);
  chmodSync(bin, 0o755);
  return {
    bin, dir, sockets: join(dir, "sock"),
    calls: () => readFileSync(log, "utf8"),
    set: (file: "list" | "screen", text: string) => writeFileSync(join(dir, file), text),
  };
}

test("spawn: zmx run in the role's cwd with FLOW_SESSION and the prompt in its environment, then labels; the id is zmx:<name>", async () => {
  const z = fakeZmx();
  const cwd = mkdtempSync(join(tmpdir(), "flows-cwd-"));
  const id = await zmxTerminal({ bin: z.bin, dir: z.sockets }).spawn({
    cwd, spawn: "claude --x", prompt: "it's\ngo", workspace: "zmx", name: "flows-pr loop#3-pm",
    labels: { run: "pr loop.3", role: "pm" },
  });
  assert.equal(id, "zmx:flows-pr-loop-3-pm");
  assert.ok(existsSync(z.sockets), "the socket directory is created");
  const real = (await import("node:fs")).realpathSync(cwd);
  assert.equal(z.calls(),
    // only a fixed command line is typed into the session's shell; the prompt never passes through it
    `${z.sockets}|${real}|{zmx:flows-pr-loop-3-pm}{it's\ngo}[run][flows-pr-loop-3-pm][-d][exec][/bin/zsh][-lc][p=$FLOW_PROMPT; unset FLOW_PROMPT; exec claude --x "$p"]\n` +
    `${z.sockets}|${process.cwd()}|[set][flows-pr-loop-3-pm][run=pr-loop.3][role=pm]\n`);
});

test("type sends the text, then a CR alone, through zmx type; press goes through zmx send", async () => {
  const z = fakeZmx();
  const t = zmxTerminal({ bin: z.bin, dir: z.sockets, submitDelayMs: 0 });
  await t.type("zmx:flows-a", "/clear\n");
  await t.press("zmx:flows-a", "\x1b[B");
  const p = `${z.sockets}|${process.cwd()}|`;
  assert.equal(z.calls(), `${p}[type][flows-a]</clear>\n${p}[type][flows-a]<\r>\n${p}[send][flows-a][\x1b[B]\n`);
});

test("text drops the screen header; userInput reads the caret column from it", async () => {
  const z = fakeZmx();
  const t = zmxTerminal({ bin: z.bin, dir: z.sockets });
  assert.equal(await t.text("zmx:flows-a"), "❯ \nline two\n");
  assert.equal(await t.userInput("zmx:flows-a"), false); // column 2: an empty input box
  z.set("screen", "45 120 24 9 10 0\n❯ draft\n");
  assert.equal(await t.userInput("zmx:flows-a"), true);
  process.env.FAKE_FAIL = "1";
  try {
    assert.equal(await t.userInput("zmx:flows-a"), false); // cannot tell
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test("tree parses zmx list; no sessions is an empty list", async () => {
  const z = fakeZmx();
  const t = zmxTerminal({ bin: z.bin, dir: z.sockets });
  assert.deepEqual(await t.tree(), []);
  z.set("list", "  name=flows-a\tpid=1\tclients=0\tcreated=1\tcwd=file://host/private/tmp/my%20dir\trun=p.1\trole=pm\n" +
    "  name=flows-b\tpid=2\tclients=1\tcreated=2\tcwd=/w\n");
  assert.deepEqual(await t.tree(), [
    { id: "zmx:flows-a", name: "flows-a", cwd: "/private/tmp/my dir", workspace: "zmx" },
    { id: "zmx:flows-b", name: "flows-b", cwd: "/w", workspace: "zmx" },
  ]);
});

test("focus opens a zmx attach in agterm and raises it; without agterm it says what to run", async () => {
  const z = fakeZmx();
  const ctl = join(z.dir, "agtermctl");
  const log = join(z.dir, "ctl.log");
  writeFileSync(ctl, `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> '${log}'; done; echo >> '${log}'\n[ -n "$FAKE_FAIL" ] && exit 3\nexit 0\n`);
  chmodSync(ctl, 0o755);
  const t = zmxTerminal({ bin: z.bin, dir: z.sockets, agtermctl: ctl, opener: ctl });
  await t.focus("zmx:flows-a");
  const attach = `env ZMX_DIR='${z.sockets}' '${z.bin}' attach 'flows-a'`;
  assert.equal(readFileSync(log, "utf8"), `[session][new][--command][${attach}][--name][flows-a]\n[-a][agterm]\n`);
  process.env.FAKE_FAIL = "1";
  try {
    await assert.rejects(t.focus("zmx:flows-a"), (e: Error) => e.message.includes(attach));
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

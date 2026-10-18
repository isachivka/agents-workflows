import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator } from "../src/translate.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "flows-tr-"));

/** A fake translator: node -e with the instruction as its argument. `log` gets "+" on start, "-" on end. */
function fake(o: { log?: string; delayMs?: number; pidFile?: string; child?: boolean; exit?: number; stderr?: string; echoArgs?: boolean } = {}): string[] {
  const script = `
    const fs = require("fs"); const o = ${JSON.stringify(o)};
    if (o.pidFile) fs.writeFileSync(o.pidFile, String(o.child
      ? require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }).pid
      : process.pid));
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      if (o.log) fs.appendFileSync(o.log, "+");
      setTimeout(() => {
        if (o.log) fs.appendFileSync(o.log, "-");
        if (o.stderr) process.stderr.write(o.stderr);
        if (o.exit) process.exit(o.exit);
        process.stdout.write(o.echoArgs ? process.argv.slice(1).join(" ") : "RU: " + s);
      }, o.delayMs || 0);
    });`;
  return [process.execPath, "-e", script];
}
const tr = (argv: string[], extra: Partial<{ timeoutMs: number; max: number; dir: string }> = {}) =>
  new Translator({ argv, dir: extra.dir ?? tmp(), timeoutMs: extra.timeoutMs ?? 10_000, max: extra.max ?? 2 });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

test("translates through the command, then answers from the cache without starting it", async () => {
  const log = join(tmp(), "log"), dir = tmp();
  const t = tr(fake({ log }), { dir });
  assert.equal(await t.translate("Do B", "ru"), "RU: Do B");
  assert.equal(await t.translate("Do B", "ru"), "RU: Do B");
  assert.equal(readFileSync(log, "utf8"), "+-");
  assert.deepEqual(readdirSync(dir).filter((n) => !n.endsWith(".txt")), []); // no temp file left
  assert.equal(await t.translate("Do C", "ru"), "RU: Do C"); // another text: another run
  assert.equal(readFileSync(log, "utf8"), "+-+-");
});

test("the instruction is the last argument and names the language", async () => {
  const out = await tr(fake({ echoArgs: true })).translate("x", "ru");
  assert.match(out, /into Russian/);
  assert.match(out, /\{\{placeholders\}\}/);
});

test("one run per text, at most two at once", async () => {
  const log = join(tmp(), "log");
  const t = tr(fake({ log, delayMs: 150 }));
  const got = await Promise.all(["a", "a", "b", "c", "d"].map((x) => t.translate(x, "ru")));
  assert.deepEqual(got, ["RU: a", "RU: a", "RU: b", "RU: c", "RU: d"]);
  const marks = readFileSync(log, "utf8");
  assert.equal(marks.split("+").length - 1, 4);
  let depth = 0, most = 0;
  for (const m of marks) { depth += m === "+" ? 1 : -1; most = Math.max(most, depth); }
  assert.equal(most, 2);
});

test("a translator that runs out of time is killed with everything it started", async () => {
  const pidFile = join(tmp(), "pid");
  const t = tr(fake({ pidFile, child: true, delayMs: 60_000 }), { timeoutMs: 300 });
  await assert.rejects(t.translate("x", "ru"), /took longer than .* and was stopped/);
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});

test("a failing translator: its exit code and the last lines of its stderr", async () => {
  const stderr = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join("\n");
  const err = await tr(fake({ exit: 3, stderr })).translate("x", "ru").catch((e: Error) => e);
  assert.match(String(err), /exit 3/);
  assert.match(String(err), /line8/);
  assert.doesNotMatch(String(err), /line3\b/);
  const empty = await tr([process.execPath, "-e", "process.stdin.resume()"]).translate("x", "ru").catch((e: Error) => e);
  assert.match(String(empty), /printed nothing/);
  const missing = await tr(["/no/such/translator"]).translate("x", "ru").catch((e: Error) => e);
  assert.match(String(missing), /could not start/);
});

test("close stops a running translation and its process group", async () => {
  const pidFile = join(tmp(), "pid");
  const t = tr(fake({ pidFile, child: true, delayMs: 60_000 }));
  const p = t.translate("x", "ru").catch((e: Error) => e);
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.close();
  assert.match(String(await p), /shutting down/);
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});

test("a group that ignores SIGTERM and holds stdout open: the request still ends at once and the group is killed", async () => {
  const pidFile = join(tmp(), "pid");
  const script = `
    const fs = require("fs");
    const g = require("child_process").spawn(process.execPath, ["-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "inherit" });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    process.stdin.resume(); setTimeout(() => {}, 60000);`;
  const t = tr([process.execPath, "-e", script], { timeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(t.translate("x", "ru"), /took longer than 300 ms and was stopped/);
  assert.ok(Date.now() - started < 1000, "settled without waiting for stdio to close");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});

test("close kills a group that ignores SIGTERM at once, as the process exits right after", async () => {
  const pidFile = join(tmp(), "pid");
  const script = `
    const fs = require("fs");
    const g = require("child_process").spawn(process.execPath, ["-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    process.stdin.resume(); setTimeout(() => {}, 60000);`;
  const t = tr([process.execPath, "-e", script]);
  const p = t.translate("x", "ru").catch((e: Error) => e);
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.close();
  await p;
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});

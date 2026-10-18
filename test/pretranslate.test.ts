import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP_FILES, makeHome, proc, startFlowd } from "./daemon-helpers.ts";

const TWO = proc("  - {step: b, role: pm}\n  - {step: c, role: pm}\n");
const RU = { "steps/ru.md": "---\nsummary: ru\n---\nСделай шаг и отчитайся командой flow done.\n" };

/** A fake translator that notes each call in `log`; `fail` makes it exit 1. */
const translator = (log: string, fail = false) => [process.execPath, "-e",
  `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { require("node:fs").appendFileSync(${JSON.stringify(log)}, "call\\n");`
  + (fail ? ` process.stderr.write("not logged in"); process.exit(1); });` : ` process.stdout.write("[ru] " + s); });`)];
const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
const cached = (home: string) => (existsSync(join(home, "translations")) ? readdirSync(join(home, "translations")).filter((f) => f.endsWith(".txt")) : []);

async function until(ok: () => boolean, what: string, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 10))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

test("flowd translates the steps ahead of time, skips one already in Russian, and a click then starts nothing", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO, ...RU });
  const log = join(home, "calls.log");
  const { f } = await startFlowd(home, { translate: translator(log), pretranslate: ["ru"], pretranslateDelayMs: 5 });
  await until(() => cached(home).length === 2, "two cached translations");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(log), 2); // b and c; the Russian step is not sent
  assert.deepEqual(await f.translateStep("b", "ru"), { text: "[ru] Do B for {{run.id}}" });
  assert.equal(calls(log), 2);
  await f.close();
});

test("an edited step is translated anew once the edits settle, and its old translation goes", async () => {
  const home = makeHome({ ...STEP_FILES, ...TWO });
  const log = join(home, "calls.log");
  const { f } = await startFlowd(home, { translate: translator(log), pretranslate: ["ru"], pretranslateDelayMs: 5 });
  await until(() => cached(home).length === 2, "the first pass");
  writeFileSync(join(home, "steps/c.md"), "---\nsummary: c\n---\nDo C, then D\n");
  f.reloadDefs();
  await until(() => calls(log) === 3, "the edited step's translation");
  await until(() => cached(home).length === 2, "the old translation removed");
  assert.deepEqual(await f.translateStep("c", "ru"), { text: "[ru] Do C, then D" });
  assert.equal(calls(log), 3);
  await f.close();
});

test("without pretranslate nothing runs; a failing translator stops the pass after one try", async () => {
  const off = makeHome({ ...STEP_FILES, ...TWO });
  const offLog = join(off, "calls.log");
  const a = await startFlowd(off, { translate: translator(offLog), pretranslateDelayMs: 5 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls(offLog), 0);
  await a.f.close();

  const bad = makeHome({ ...STEP_FILES, ...TWO });
  const badLog = join(bad, "calls.log");
  const logs: string[] = [];
  const b = await startFlowd(bad, { translate: translator(badLog, true), pretranslate: ["ru"], pretranslateDelayMs: 5, log: (m: string) => logs.push(m) });
  await until(() => calls(badLog) === 1, "one try");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls(badLog), 1);
  assert.ok(logs.some((m) => /translating steps ahead stopped: .*not logged in/s.test(m)), logs.join("\n"));
  await b.f.close();
});

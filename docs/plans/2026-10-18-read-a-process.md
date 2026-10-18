# Reading a process — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The process page explains how each entry works in a side panel, and a step's prompt can be translated by a local Codex model.

**Architecture:** `src/translate.ts` runs a translator command (Codex `gpt-6-luna` by default) with a cache, a concurrency cap and process-group kills; `Flowd.translateStep` and `POST /api/steps/:id/translate` expose it. `GET /api/processes` and `GET /api/steps/:id` gain the fields the panel shows. `ui/text.js` turns entries into badges and plain "how it works" lines; `ui/app.js` makes entry cards links to `#/process/<name>/step/<id>` and draws the panel and the Translate control.

**Tech Stack:** Node 24 TypeScript (erasable syntax), `node:test`, Preact + htm (vendored, no build).

**Spec:** `docs/specs/2026-10-18-read-a-process-design.md`

## Global Constraints

- Erasable TypeScript only: no `enum`, `namespace`, constructor parameter properties; relative imports end in `.ts`; type-only imports use `import type`.
- No new dependency.
- No test reaches the real `codex`, agterm, `~/.config/flows`, `~/.local/state/flows` or `~/.claude`: `startFlowd` and `scripts/ui-preview.ts` default `translate` to a fake.
- The translator is an argv, never a shell string with the instruction pasted in; it runs detached in its own process group; on the time limit and on `Flowd.close()` the group is killed.
- At most 2 translations run at once.
- Every UI string goes through `t()`/`tn()` with EN and RU keys (`test/ui-text.test.ts` checks parity and that every used key exists).
- Author text (summaries, prompts, commands) is shown as written.
- One commit per task; `npm test` and `npm run typecheck` green after each. Stage only the files the task names: other sessions commit in this checkout.
- The repo is public: no personal or employer names in code, tests, fixtures or commit messages.

## Review Focus

1. A translator that hangs or spawns children — the group must be gone after the timeout or `close()`, or flowd leaks processes (tested in Task 1).
2. Many quick clicks on different steps — no more than two `codex` at once (tested in Task 1).
3. A step edited after it was translated — the edited text is translated anew, not served stale (tested in Task 1).
4. A process with no `roleDefs` (invalid YAML) still renders its page and its panel without throwing (tested in Task 3: `entryFacts` with no role definitions).
5. The panel on a phone (320–430 px) — full screen, no horizontal scroll, Close reachable (checked by hand in Task 4).

---

### Task 1: The translator

**Files:**
- Create: `src/translate.ts`
- Create: `test/translate.test.ts`
- Modify: `src/daemon.ts` (drop its local `killGroup`, import it from `translate.ts`)

**Interfaces:**
- Produces: `export function killGroup(c: ChildProcess): void`; `export function instruction(lang: string): string`; `export interface TranslatorOptions { argv: string[]; dir: string; timeoutMs: number; max: number }`; `export class Translator { constructor(o: TranslatorOptions); translate(body: string, lang: string): Promise<string>; close(): void }`. `translate` rejects with an `Error` whose message says what went wrong, followed by the last 5 stderr lines.

- [ ] **Step 1: Write the failing tests** — `test/translate.test.ts`:

```ts
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
  const t = tr(fake({ pidFile, delayMs: 60_000 }));
  const p = t.translate("x", "ru").catch((e: Error) => e);
  await until(() => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.close();
  assert.match(String(await p), /shutting down/);
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/translate.test.ts`
Expected: FAIL — `Cannot find module '../src/translate.ts'`.

- [ ] **Step 3: Write `src/translate.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ends a detached child and everything it started; it may have exited already. */
export function killGroup(c: ChildProcess): void {
  try {
    if (c.pid) process.kill(-c.pid, "SIGTERM");
  } catch {
    c.kill();
  }
}

const LANG_NAMES: Record<string, string> = { ru: "Russian", en: "English" };

export const instruction = (lang: string): string =>
  `Translate the text on stdin into ${LANG_NAMES[lang] ?? lang}. Keep code, commands, shell snippets, {{placeholders}}, ` +
  "URLs, file paths and Markdown exactly as they are. Output only the translation, nothing else.";

export interface TranslatorOptions {
  /** the command; the instruction is appended as its last argument and the text goes to stdin */
  argv: string[];
  /** where translations are cached, one file per command, instruction and text */
  dir: string;
  timeoutMs: number;
  /** how many may run at once; the rest wait in line */
  max: number;
}

/** Translates a step's text for the person reading it, with a local command (Codex by default). */
export class Translator {
  private o: TranslatorOptions;
  private running = 0;
  private waiting: (() => void)[] = [];
  private pending = new Map<string, Promise<string>>();
  private children = new Set<ChildProcess>();
  private closed = false;

  constructor(o: TranslatorOptions) {
    this.o = o;
  }

  translate(body: string, lang: string): Promise<string> {
    const argv = [...this.o.argv, instruction(lang)];
    // the command and the instruction are in the key: changing either must not serve old translations
    const key = createHash("sha256").update(JSON.stringify([argv, body])).digest("hex");
    const file = join(this.o.dir, `${key}.txt`);
    if (existsSync(file)) return Promise.resolve(readFileSync(file, "utf8"));
    let p = this.pending.get(key);
    if (!p) {
      p = this.slot(() => this.run(argv, body))
        .then((text) => {
          mkdirSync(this.o.dir, { recursive: true });
          const part = `${file}.${process.pid}.part`;
          writeFileSync(part, text);
          renameSync(part, file); // a reader never sees half a file
          return text;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  close(): void {
    this.closed = true;
    for (const c of this.children) killGroup(c);
    for (const wake of this.waiting.splice(0)) wake();
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (!this.closed && this.running >= this.o.max) await new Promise<void>((r) => this.waiting.push(r));
    if (this.closed) throw new Error("flows is shutting down");
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private run(argv: string[], body: string): Promise<string> {
    const [bin, ...args] = argv;
    const cwd = mkdtempSync(join(tmpdir(), "flows-translate-"));
    return new Promise((resolve, reject) => {
      let timedOut = false;
      // its own process group: a timeout or a shutdown ends what the translator started too
      const child = spawn(bin, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      this.children.add(child);
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout!.on("data", (b: Buffer) => out.push(b));
      child.stderr!.on("data", (b: Buffer) => err.push(b));
      child.stdin!.on("error", () => {}); // a translator that exits before reading: its exit says why
      child.stdin!.end(body);
      const timer = setTimeout(() => { timedOut = true; killGroup(child); }, this.o.timeoutMs);
      let ended = false;
      const end = (code: number | null, error?: Error) => {
        if (ended) return; // a spawn error may be followed by close
        ended = true;
        clearTimeout(timer);
        this.children.delete(child);
        rmSync(cwd, { recursive: true, force: true });
        const text = Buffer.concat(out).toString().trim();
        const tail = Buffer.concat(err).toString().trim().split("\n").slice(-5).join("\n");
        const fail = (why: string) => reject(new Error(tail ? `${why}:\n${tail}` : why));
        if (error) return fail(`the translator could not start (${error.message})`);
        if (timedOut) return fail(`the translator took longer than ${Math.round(this.o.timeoutMs / 1000)} s and was stopped`);
        if (this.closed) return fail("flows is shutting down");
        if (code !== 0) return fail(`the translator failed (exit ${code})`);
        if (!text) return fail("the translator printed nothing");
        resolve(text);
      };
      child.on("error", (e) => end(null, e));
      child.on("close", (code) => end(code));
    });
  }
}
```

In `src/daemon.ts`: delete the local `killGroup` function (lines 80–87, "Ends a detached child and everything it started") and add `import { killGroup } from "./translate.ts";` next to the other `./` imports. `ChildProcess` stays imported if other code still uses it (`this.children`).

- [ ] **Step 4: Run the tests**

Run: `node --test test/translate.test.ts && npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/translate.ts test/translate.test.ts src/daemon.ts
git commit -m "feat: a translator for step prompts — a local command, cached, two at a time, killed with its group"
```

---

### Task 2: flowd and the API

**Files:**
- Modify: `src/daemon.ts` (options, `translator` field, `close()`, `translateStep`)
- Modify: `src/http.ts` (`listProcesses`, `getDef`, the translate route)
- Modify: `test/daemon-helpers.ts` (fake translator by default)
- Modify: `scripts/ui-preview.ts` (fake translator)
- Modify: `test/http.test.ts`
- Modify: `docs/http-api.md`

**Interfaces:**
- Consumes: `Translator`, `TranslatorOptions` from Task 1.
- Produces:
  - `FlowdOptions.translate?: string[]`, `FlowdOptions.translateTimeoutMs?: number`
  - `Flowd.translateStep(id: string, lang: unknown): Promise<{ text: string } | { error: string; status: number }>`
  - `export const FAKE_TRANSLATE: string[]` in `test/daemon-helpers.ts`: prints `"[translated] " + <stdin>`.
  - `GET /api/processes` items add `path, workspace, terminal, roleDefs: [{name, agent: "claude"|"codex"|"other", beside: string|null, cwd: string|null}]`; each entry adds `timeoutMs, retries, hold, with, waitWith, waitWhere, text, cwd, skills`.
  - `GET /api/steps/:id` and `/api/processes/:name` add `path`. Paths under the home directory start with `~`.
  - `POST /api/steps/:id/translate` `{lang: "ru"|"en"}` → `{text}`; 400 / 404 / 502 `{error}`.

- [ ] **Step 1: Make every test flowd use a fake translator** — in `test/daemon-helpers.ts`, above `startFlowd`:

```ts
/** A translator that never reaches codex: "[translated] " and the text it got. */
export const FAKE_TRANSLATE = [process.execPath, "-e",
  'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write("[translated] " + s));'];
```

and in the `new Flowd({ ... })` options of `startFlowd`, after `codexDir`:

```ts
    translate: FAKE_TRANSLATE, // never the real codex
```

- [ ] **Step 2: Write the failing tests** — append to `test/http.test.ts`:

```ts
test("processes and steps carry what the reading view shows", async () => {
  const s = await serve({
    ...STEP_FILES,
    "steps/c.md": "---\nsummary: c\nskills: [gh-cli]\n---\nDo C\n",
    "processes/p.yaml": `description: d
cwd: /tmp
workspace: W
roles:
  pm: {spawn: claude}
  peer: {spawn: codex, beside: pm, cwd: /var}
steps:
  - {step: b, role: pm, timeout: 1h, hold: desk}
  - {id: ci, wait_for: {on: signal.ci, where: {repo: x}, with: {from: requested}}, on_fail: retry, retries: 5}
  - {step: c, role: pm}
  - {id: hi, do: type, role: peer, text: hello}
  - {id: sh1, sh: 'echo hi', cwd: /tmp, timeout: 5m}
`,
  });
  const [p] = (await s.call("GET", "/api/processes")).body;
  assert.equal(p.path, join(s.home, "processes", "p.yaml"));
  assert.deepEqual([p.workspace, p.terminal], ["W", "agterm"]);
  assert.deepEqual(p.roleDefs, [
    { name: "pm", agent: "claude", beside: null, cwd: null },
    { name: "peer", agent: "codex", beside: "pm", cwd: "/var" },
  ]);
  const [b, ci, c, hi, sh1] = p.entries;
  assert.deepEqual([b.timeoutMs, b.hold, b.skills], [3_600_000, "desk", []]);
  assert.deepEqual([ci.waitFor, ci.waitWith, ci.waitWhere, ci.onFail, ci.retries], ["signal.ci", { from: "requested" }, { repo: "x" }, "retry", 5]);
  assert.deepEqual(c.skills, ["gh-cli"]);
  assert.deepEqual([hi.do, hi.text, hi.role], ["type", "hello", "peer"]);
  assert.deepEqual([sh1.sh, sh1.cwd, sh1.timeoutMs], ["echo hi", "/tmp", 300_000]);
  assert.equal((await s.call("GET", "/api/steps/c")).body.path, join(s.home, "steps", "c.md"));
  assert.equal((await s.call("GET", "/api/processes/p")).body.path, join(s.home, "processes", "p.yaml"));
  await s.close();
});

test("translate a step's prompt: the translator's text, refusals, a failure says why", async () => {
  const s = await serve({ ...STEP_FILES, ...TWO });
  const ok = await s.call("POST", "/api/steps/b/translate", { lang: "ru" });
  assert.deepEqual([ok.status, ok.body], [200, { text: "[translated] Do B for {{run.id}}" }]);
  assert.equal((await s.call("POST", "/api/steps/nope/translate", { lang: "ru" })).status, 404);
  const de = await s.call("POST", "/api/steps/b/translate", { lang: "de" });
  assert.deepEqual([de.status, de.body.error], [400, "lang must be ru or en"]);
  await s.close();
  const bad = await serve({ ...STEP_FILES, ...TWO }, { translate: [process.execPath, "-e", 'process.stderr.write("not logged in"); process.exit(1)'] });
  const r = await bad.call("POST", "/api/steps/b/translate", { lang: "ru" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /exit 1[\s\S]*not logged in[\s\S]*original text is still there/);
  await bad.close();
});
```

If `signal.ci` with `where`/`with` is refused by validation, use the test plugin's event (`test.ping`) instead; keep the assertions on `waitWith`/`waitWhere`.

- [ ] **Step 3: Run them to see them fail**

Run: `node --test test/http.test.ts`
Expected: FAIL — `p.path` is `undefined`; translate returns 404.

- [ ] **Step 4: flowd** — in `src/daemon.ts`:

Add to the imports: `Translator` (`import { killGroup, Translator } from "./translate.ts";`) and `dirname` from `node:path` if not imported yet.

Add to `FlowdOptions` after `shell`:

```ts
  /** the translator for step prompts: an argv; the instruction is appended, the text goes to stdin (default: Codex gpt-6-luna) */
  translate?: string[];
  /** how long a translation may take before its process group is killed (default 2 minutes) */
  translateTimeoutMs?: number;
```

Above `class Flowd`:

```ts
// the login shell finds codex; "$@" passes the argv through without quoting anything into a string
const TRANSLATE = ["/bin/zsh", "-lc", 'exec "$@"', "zsh", "codex", "exec", "-m", "gpt-6-luna", "--sandbox", "read-only",
  "--ephemeral", "--skip-git-repo-check", "-c", "model_reasoning_effort=low"];
```

A field next to the others: `private translator: Translator;`, and in the constructor after `this.o = o` (or wherever options are stored):

```ts
    this.translator = new Translator({
      argv: o.translate ?? TRANSLATE, dir: join(dirname(o.statePath), "translations"),
      timeoutMs: o.translateTimeoutMs ?? 120_000, max: 2,
    });
```

In `close()`, right after `this.closing = true;`: `this.translator.close();`

A method near `show`/`preview`:

```ts
  /** A step's prompt in another language, for the person reading the process (the agent still gets the original). */
  async translateStep(id: string, lang: unknown): Promise<{ text: string } | { error: string; status: number }> {
    if (lang !== "ru" && lang !== "en") return { error: "lang must be ru or en", status: 400 };
    const s = this.defs.steps[id];
    if (!s) return { error: `no step ${id}`, status: 404 };
    try {
      return { text: await this.translator.translate(s.body, lang) };
    } catch (e) {
      return { error: `${(e as Error).message}\nThe original text is still there.`, status: 502 };
    }
  }
```

- [ ] **Step 5: the API** — in `src/http.ts`:

Imports: `homedir` from `node:os`, `agentOf` from `./skills.ts`.

```ts
const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);
const defPath = (f: Flowd, kind: DefKind, name: string) =>
  tilde(join(f.home, kind === "process" ? "processes" : "steps", `${name}${kind === "process" ? ".yaml" : ".md"}`));
```

In `listProcesses`, after `triggers: …, roles: …,` add:

```ts
      path: defPath(f, "process", name), workspace: p?.workspace ?? name, terminal: p?.terminal ?? "agterm",
      roleDefs: p ? Object.entries(p.roles).map(([n, r]) => ({ name: n, agent: agentOf(r.spawn), beside: r.beside ?? null, cwd: r.cwd ?? null })) : [],
```

and in the entry map, after `sh: e.sh ?? null,`:

```ts
        timeoutMs: e.timeoutMs ?? null, retries: e.retries, hold: e.hold ?? null, with: e.with,
        waitWith: e.waitFor?.with ?? null, waitWhere: e.waitFor?.where ?? null, text: e.text ?? null, cwd: e.cwd ?? null,
        skills: e.step ? f.defs.steps[e.step]?.skills ?? [] : [],
```

In `getDef`, add `path: defPath(f, kind, name)` to both returned objects.

In `makeServer`'s `routes`, after the `/preview` route:

```ts
    ["POST", /^\/api\/steps\/([^/]+)\/translate$/, async ([id], b) => {
      const r = await f.translateStep(id, b.lang);
      if ("error" in r) throw new HttpError(r.status, { error: r.error });
      return r;
    }],
```

- [ ] **Step 6: the preview** — in `scripts/ui-preview.ts`, import `FAKE_TRANSLATE` is not enough (it answers at once); add after `const step = …`:

```ts
// a translator that takes a moment, like the real one, and never reaches codex
const SLOW_TRANSLATE = [process.execPath, "-e",
  'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => setTimeout(() => process.stdout.write("[RU] " + s), 1500));'];
```

and add `translate: SLOW_TRANSLATE` to its `new Flowd({ … })` options.

- [ ] **Step 7: docs** — in `docs/http-api.md`:
  - the `GET /api/processes` row: add `path, workspace, terminal, roleDefs` to the item list, `timeoutMs, retries, hold, with, waitWith, waitWhere, text, cwd, skills` to the entry list, and the sentence "`roleDefs`: `[{name, agent: claude|codex|other, beside, cwd}]`; paths under the home directory start with `~`; `with` is a plugin action's arguments, `waitWith`/`waitWhere` the wait's conditions".
  - the `GET /api/processes/:name` and `GET /api/steps/:id` rows: add `path`.
  - a new row after `/api/steps/:id/preview`:
    `| POST | /api/steps/:id/translate | {lang: "ru" \| "en"} | {text}: the step's prompt translated for the person reading it (Codex gpt-6-luna by default, cached under the state directory's translations/, at most two at once, 2-minute limit). 400 bad lang, 404 unknown step, 502 {error} when the translator fails, with the last lines of its stderr |`

- [ ] **Step 8: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/daemon.ts src/http.ts test/daemon-helpers.ts test/http.test.ts scripts/ui-preview.ts docs/http-api.md
git commit -m "feat(http): what the process reading view needs, and POST /api/steps/:id/translate"
```

---

### Task 3: Words for entries

**Files:**
- Modify: `ui/text.js` (functions and EN/RU keys)
- Modify: `test/ui-text.test.ts`

**Interfaces:**
- Consumes: the entry and `roleDefs` fields from Task 2.
- Produces (exports of `ui/text.js`):
  - `entryBadges(e) → [{tone: "wait"|"hold"|"lim", text}]`
  - `entryFacts(e, roleDefs) → [{k, v, mono?: true}]`
  - `agentName(agent) → string` (`"claude"|"codex"|"other"`)
  - `roleLine(rd) → string`
  - `entryWho(e, roleDefs) → string` (the panel head's small line)

- [ ] **Step 1: Write the failing tests** — append to `test/ui-text.test.ts`:

```ts
const pe = (extra: Record<string, unknown> = {}) => ({
  id: "x", kind: "agent", role: "dev", waitFor: null, detour: false, step: "x", summary: "Do x", do: null, onFail: "human",
  after: null, waitMs: null, sh: null, timeoutMs: null, retries: 3, hold: null, with: {}, waitWith: null, waitWhere: null,
  text: null, cwd: null, skills: [], ...extra,
});
const ROLES = [{ name: "dev", agent: "claude", beside: null, cwd: null }, { name: "peer", agent: "codex", beside: "dev", cwd: "/w" }];

test("entry badges: what it waits for, what it holds, its limits", () => {
  T.setLang("en");
  assert.deepEqual(T.entryBadges(pe()), []);
  assert.deepEqual(T.entryBadges(pe({ waitFor: "gh.review", onFail: "retry", retries: 50 })).map((b: any) => b.text),
    ["First waits for a PR review", "Up to 50 tries"]);
  assert.deepEqual(T.entryBadges(pe({ kind: "human", role: "human", waitFor: "gh.merged" })).map((b: any) => b.text), ["Closes itself on the PR merge"]);
  assert.deepEqual(T.entryBadges(pe({ hold: "desk", timeoutMs: 3_600_000 })).map((b: any) => [b.tone, b.text]),
    [["hold", "Holds desk"], ["lim", "At most 1 h"]]);
  assert.deepEqual(T.entryBadges(pe({ kind: "wait", role: null, step: null, waitFor: "gh.checks" })), []); // its phrase says it
  T.setLang("ru");
  assert.deepEqual(T.entryBadges(pe({ onFail: "retry", retries: 1 })).map((b: any) => b.text), ["До 1 попытки"]);
  assert.deepEqual(T.entryBadges(pe({ onFail: "retry", retries: 5 })).map((b: any) => b.text), ["До 5 попыток"]);
  T.setLang("en");
});

test("entry facts: one plain line per thing that applies", () => {
  T.setLang("en");
  const kv = (e: any, roles: any = ROLES) => T.entryFacts(e, roles).map((f: any) => [f.k, f.v]);
  assert.deepEqual(kv(pe()), [["Who", "dev — Claude agent"], ["If it fails", "asks you what to do"]]);
  assert.deepEqual(kv(pe({ waitFor: "gh.review", waitWith: { from: "requested" }, onFail: "retry", retries: 50, skills: ["gh-cli"], hold: "desk", timeoutMs: 600_000 })), [
    ["Who", "dev — Claude agent"], ["Starts on", "a PR review"], ["Conditions", "from: \"requested\""],
    ["Holds", "desk — while it runs, other runs wait their turn here"], ["At most", "10 min"], ["Skills", "gh-cli"],
    ["Tries", "Up to 50 tries"],
  ]);
  assert.deepEqual(kv(pe({ kind: "human", role: "human", waitFor: "gh.merged" })), [["Who", "You"], ["Closes itself on", "the PR merge"]]);
  assert.deepEqual(kv(pe({ kind: "action", step: null, do: "type", role: "peer", text: "" })),
    [["Who", "flows itself, no agent"], ["Does", "starts peer and types nothing: it waits to be spoken to"], ["If it fails", "asks you what to do"]]);
  const sh = T.entryFacts(pe({ kind: "action", step: null, role: null, sh: "echo hi", cwd: null, timeoutMs: 300_000, onFail: "end" }), ROLES);
  assert.deepEqual(sh.map((f: any) => [f.k, f.v, Boolean(f.mono)]), [
    ["Who", "flows itself, no agent", false], ["Runs", "echo hi", true], ["Where", "the process folder", false], ["At most", "5 min", false],
  ]);
  assert.deepEqual(kv(pe({ kind: "delay", step: null, role: null, waitMs: 72_000_000 })), [["Who", "flows itself, no agent"], ["Does", "nothing: waits 20 h, then goes on by itself"]]);
  assert.match(kv(pe({ kind: "inner", step: null }))[1][1], /dev runs a whole other process here/);
  assert.deepEqual(kv(pe({ kind: "wait", step: null, role: null, waitFor: "gh.checks", onFail: { goto: "fix" } })),
    [["Who", "flows itself, no agent"], ["Does", "waits for GitHub checks; how they end closes the step"]]);
  assert.deepEqual(kv(pe(), []), [["Who", "dev — agent"], ["If it fails", "asks you what to do"]]); // no role definitions: an invalid process
});

test("role lines and the panel's who line", () => {
  T.setLang("en");
  assert.equal(T.roleLine(ROLES[0]), "Claude agent");
  assert.equal(T.roleLine(ROLES[1]), "Codex agent · in the right half beside dev · works in /w");
  assert.equal(T.entryWho(pe(), ROLES), "dev · Claude agent");
  assert.equal(T.entryWho(pe({ kind: "human", role: "human" }), ROLES), "You");
  assert.equal(T.entryWho(pe({ kind: "action", do: "clear" }), ROLES), "flows itself, no agent");
  T.setLang("ru");
  assert.equal(T.roleLine(ROLES[1]), "агент Codex · в правой половине рядом с dev · работает в /w");
  T.setLang("en");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/ui-text.test.ts`
Expected: FAIL — `T.entryBadges is not a function`.

- [ ] **Step 3: Implement** — in `ui/text.js`, after `entryBranch`:

```js
/** The short badges on a process entry's card: what it waits for, what it holds, its limits. A pure
 * wait says what it waits for in its own phrase. */
export function entryBadges(e) {
  const out = [];
  if (e.waitFor && e.kind !== "wait") out.push({ tone: "wait", text: t(e.kind === "human" ? "badge.closesOn" : "badge.startsOn", { what: eventPhrase(e.waitFor) }) });
  if (e.hold) out.push({ tone: "hold", text: t("badge.holds", { hold: e.hold }) });
  if (e.timeoutMs) out.push({ tone: "lim", text: t("badge.timeout", { d: duration(e.timeoutMs) }) });
  if (e.onFail === "retry") out.push({ tone: "lim", text: tn("badge.tries", e.retries) });
  return out;
}

export const agentName = (agent) => t(`agent.${agent || "other"}`);
const roleDef = (role, roleDefs) => (roleDefs || []).find((r) => r.name === role) || null;

/** Under a role's name on a process page: which agent, where it runs. */
export function roleLine(rd) {
  return [agentName(rd.agent), rd.beside ? t("role.beside", { role: rd.beside }) : "", rd.cwd ? t("role.cwd", { cwd: rd.cwd }) : ""]
    .filter(Boolean).join(" · ");
}

/** The small line above an entry's title in the step panel. */
export function entryWho(e, roleDefs) {
  if (e.kind === "human") return t("You");
  if (e.kind === "agent" || e.kind === "inner") {
    const rd = roleDef(e.role, roleDefs);
    return `${e.role} · ${e.kind === "inner" ? t("fact.nested") : rd ? agentName(rd.agent) : t("proc.agent")}`;
  }
  return t("fact.flows");
}

const conditions = (e) => Object.entries({ ...(e.waitWhere || {}), ...(e.waitWith || {}) }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");

/** "How it works" in the step panel: one plain line for each thing that applies to the entry. */
export function entryFacts(e, roleDefs) {
  const out = [];
  const fact = (k, v, mono) => out.push(mono ? { k: t(k), v, mono: true } : { k: t(k), v });
  if (e.kind === "human") fact("fact.who", t("You"));
  else if (e.kind === "agent" || e.kind === "inner") {
    const rd = roleDef(e.role, roleDefs);
    fact("fact.who", `${e.role} — ${rd ? agentName(rd.agent) : t("proc.agent")}`);
  } else fact("fact.who", t("fact.flows"));
  if (e.kind === "inner") fact("fact.does", t("does.inner", { role: e.role }));
  if (e.kind === "delay") fact("fact.does", t("does.pause", { d: duration(e.waitMs || 0) }));
  if (e.kind === "wait") fact("fact.does", t("does.wait", { what: eventPhrase(e.waitFor || "") }));
  if (e.kind === "action" && e.sh) {
    fact("fact.runs", e.sh, true);
    fact("fact.where", e.cwd || t("fact.procFolder"));
  } else if (e.kind === "action" && e.do === "type") {
    fact("fact.does", e.text ? t("does.type", { role: e.role, text: e.text }) : t("does.typeNothing", { role: e.role }));
  } else if (e.kind === "action" && e.do) {
    fact("fact.does", ["clear", "compact"].includes(e.do) ? t(`do.${e.do}`, { role: e.role }) : t("do.plugin", { name: e.do }));
    if (e.with && Object.keys(e.with).length) fact("fact.args", JSON.stringify(e.with), true);
  }
  if (e.waitFor && e.kind !== "wait") fact(e.kind === "human" ? "fact.closesOn" : "fact.startsOn", eventPhrase(e.waitFor));
  if (e.waitFor && conditions(e)) fact("fact.cond", conditions(e), true);
  if (e.hold) fact("fact.holds", t("fact.holdsV", { hold: e.hold }));
  if (e.timeoutMs) fact("fact.timeout", duration(e.timeoutMs));
  if (e.skills && e.skills.length) fact("fact.skills", e.skills.join(", "));
  if (e.onFail === "retry") fact("fact.tries", tn("badge.tries", e.retries));
  if (e.onFail === "human" && (e.kind === "agent" || e.kind === "action")) fact("fact.ifFails", t("fact.asksYou"));
  return out;
}
```

Keys — add to `EN`:

```js
  "badge.startsOn": "First waits for {what}", "badge.closesOn": "Closes itself on {what}", "badge.holds": "Holds {hold}",
  "badge.timeout": "At most {d}", "badge.tries.one": "Up to {n} try", "badge.tries.other": "Up to {n} tries",
  "agent.claude": "Claude agent", "agent.codex": "Codex agent", "agent.other": "agent",
  "role.beside": "in the right half beside {role}", "role.cwd": "works in {cwd}",
  "fact.who": "Who", "fact.does": "Does", "fact.runs": "Runs", "fact.where": "Where", "fact.args": "With",
  "fact.startsOn": "Starts on", "fact.closesOn": "Closes itself on", "fact.cond": "Conditions", "fact.holds": "Holds",
  "fact.holdsV": "{hold} — while it runs, other runs wait their turn here", "fact.timeout": "At most", "fact.skills": "Skills",
  "fact.tries": "Tries", "fact.ifFails": "If it fails", "fact.asksYou": "asks you what to do",
  "fact.flows": "flows itself, no agent", "fact.procFolder": "the process folder", "fact.nested": "a nested process",
  "does.inner": "{role} runs a whole other process here, and this one waits until it ends. Which process is chosen at the start (flow start --inner) or here, when the run gets to it.",
  "does.pause": "nothing: waits {d}, then goes on by itself", "does.wait": "waits for {what}; how they end closes the step",
  "does.type": "types into {role}: {text}", "does.typeNothing": "starts {role} and types nothing: it waits to be spoken to",
```

and to `RU`:

```js
  "badge.startsOn": "Сначала ждёт: {what}", "badge.closesOn": "Закроется сам: {what}", "badge.holds": "Занимает {hold}",
  "badge.timeout": "Не дольше {d}", "badge.tries.one": "До {n} попытки", "badge.tries.few": "До {n} попыток",
  "badge.tries.many": "До {n} попыток", "badge.tries.other": "До {n} попытки",
  "agent.claude": "агент Claude", "agent.codex": "агент Codex", "agent.other": "программа",
  "role.beside": "в правой половине рядом с {role}", "role.cwd": "работает в {cwd}",
  "fact.who": "Кто делает", "fact.does": "Что делает", "fact.runs": "Выполняет", "fact.where": "Где", "fact.args": "С параметрами",
  "fact.startsOn": "Начинается после", "fact.closesOn": "Закроется сам", "fact.cond": "Условия", "fact.holds": "Занимает",
  "fact.holdsV": "{hold} — пока шаг идёт, другие запуски ждут здесь своей очереди", "fact.timeout": "Не дольше", "fact.skills": "Навыки",
  "fact.tries": "Попытки", "fact.ifFails": "Если не получилось", "fact.asksYou": "спросит тебя, что делать",
  "fact.flows": "flows сам, без агента", "fact.procFolder": "папка процесса", "fact.nested": "вложенный процесс",
  "does.inner": "{role} целиком проходит здесь другой процесс, а этот ждёт, пока тот закончится. Какой процесс — выбирают при запуске (flow start --inner) или здесь же, когда запуск дойдёт до этого места.",
  "does.pause": "ничего: ждёт {d} и идёт дальше сам", "does.wait": "ждёт: {what}; чем они кончатся, тем и закроется шаг",
  "does.type": "печатает в {role}: {text}", "does.typeNothing": "запускает {role} и ничего не печатает: он ждёт, пока к нему обратятся",
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/ui-text.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/text.js test/ui-text.test.ts
git commit -m "feat(ui): words for how an entry works — badges, facts, roles"
```

---

### Task 4: The process page reads, the step panel, Translate

**Files:**
- Modify: `ui/lib.js` (icons `close`, `translate`, `copy`, `nest`, `shell`)
- Modify: `ui/app.js`
- Modify: `ui/style.css`
- Modify: `ui/text.js` (keys `read.*`)
- Modify: `scripts/ui-preview.ts` (a process with every kind of entry)

**Interfaces:**
- Consumes: Task 2 API fields, Task 3 `entryBadges`, `entryFacts`, `roleLine`, `entryWho`.
- Produces: route `#/process/<name>/step/<entry id>`; components `StepPanel`, `Prompt`, `PathRow`.

- [ ] **Step 1: Icons** — add to `PATHS` in `ui/lib.js`:

```js
  close: html`<path d="M6 6l12 12M18 6L6 18" />`,
  translate: html`<path d="M4 5h9M8.5 3v2M6 5c1 4 4 7 7 8" /><path d="M11 5c-1 4-4 7-7 8" /><path d="M13 21l4-9 4 9M14.5 18h5" />`,
  copy: html`<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />`,
  nest: html`<rect x="3" y="3" width="18" height="18" rx="3" /><rect x="8" y="8" width="8" height="8" rx="2" />`,
  shell: html`<path d="M4 17l6-6-6-6" /><path d="M12 19h8" />`,
```

- [ ] **Step 2: Keys** — add to `EN` in `ui/text.js`:

```js
  "read.hint": "Click a step to read it whole", "read.panel": "Step", "read.of": "Step {n} of {total}", "read.how": "How it works",
  "read.where": "Where it lives", "read.stepFile": "The step's text", "read.procFile": "The process, step {n}",
  "read.translate": "Translate", "read.translating": "Translating… about 10 seconds", "read.translation": "Translation",
  "read.original": "Original", "read.textLang": "Language of the text", "read.byLuna": "Translated by Codex (Luna). Commands and placeholders are kept as the agent sees them.",
  "act.close": "Close", "act.copy": "Copy", "act.copied": "Copied",
```

and to `RU`:

```js
  "read.hint": "Нажми на шаг, чтобы прочитать его целиком", "read.panel": "Шаг", "read.of": "Шаг {n} из {total}", "read.how": "Как устроен",
  "read.where": "Где лежит", "read.stepFile": "Текст шага", "read.procFile": "Процесс, шаг {n}",
  "read.translate": "Перевести на русский", "read.translating": "Перевожу… обычно около 10 секунд", "read.translation": "Перевод",
  "read.original": "Оригинал", "read.textLang": "Язык текста", "read.byLuna": "Перевела Luna (Codex). Команды и подстановки оставлены как в оригинале — их видит агент.",
  "act.close": "Закрыть", "act.copy": "Скопировать", "act.copied": "Скопировано",
```

If any `act.*` key already exists, keep the existing one and drop the duplicate.

- [ ] **Step 3: The route** — in `App` (`ui/app.js`): `const [page, arg, sub, rest] = useRoute();`, pass `rest=${rest}` to `<${Page} …>`, and keep the page mounted while the panel moves between steps:

```js
    <main class="wrap page"><${Page} arg=${arg} sub=${sub} rest=${rest} lang=${lang} onLang=${onLang} key=${`${page}/${arg || ""}/${sub === "step" ? "" : sub || ""}`} /></main>`;
```

- [ ] **Step 4: The process page** — in `ui/app.js`, import `entryBadges, entryFacts, roleLine, entryWho` from `./text.js`, then replace `ProcessView`, `ProcessEntry` and `StepFold` with:

```js
const look = (e) => ({
  icon: e.kind === "human" ? "you" : e.kind === "wait" || e.kind === "delay" ? "wait" : e.kind === "inner" ? "nest" : e.kind === "action" ? (e.sh ? "shell" : "again") : "agent",
  dot: e.kind === "human" ? "hu" : e.kind === "agent" ? "ag" : e.kind === "action" ? "sy" : "wt",
});
const stepHref = (name, id) => `#/process/${enc(name)}/step/${enc(id)}`;

function ProcessView({ arg: name, sub, rest }) {
  const { data, error } = useData("/api/processes");
  const { data: runs } = useData("/api/runs");
  if (sub === "edit") return html`<${ProcessEditor} arg=${name} />`;
  if (!data) return html`<${Loading} error=${error} />`;
  const p = data.find((x) => x.name === name);
  if (!p) return html`<p class="err-box">${t("proc.missing", { name })}</p>`;
  const human = p.entries.some((e) => e.role === "human");
  const at = sub === "step" ? p.entries.findIndex((e) => e.id === rest) : -1;
  return html`
    <a class="back small" href="#/processes">← ${t("proc.all")}</a>
    <section class="head">
      <div><h1>${p.name}</h1>${p.description && html`<p class="lead">${p.description}</p>`}
        ${p.valid && html`<div class="facts">${processFacts(p).map((f) => html`<span class="fact">${f}</span>`)}</div>`}</div>
      <div class="acts">
        ${p.valid && html`<button class="btn primary" onClick=${() => go("start", p.name)}>${t("act.start")}</button>`}
        <a class="btn quiet" href="#/process/${enc(p.name)}/edit">${t("act.edit")}</a>
      </div>
    </section>
    <${DefErrors} p=${p} />
    <div class=${`read${at >= 0 ? " open" : ""}`}>
      <div class="readl">
        ${p.openRuns.length > 0 && html`<section><h2>${t("proc.openRuns")}</h2><div class="acts">
          ${p.openRuns.map((rid) => {
            const r = (runs || []).find((x) => x.id === rid);
            const d = r && describeRun(r);
            return html`<a class="btn run-chip" href="#/run/${enc(rid)}"><span class="clip">${r ? runTitle(r) || runName(r) : runLabel(rid)}</span>${d && html` <${Pill} tone=${d.tone}>${d.tag}<//>`}</a>`;
          })}</div></section>`}
        ${(p.roleDefs.length > 0 || human) && html`<section><h2>${t("proc.who")}</h2><div class="ppl">
          ${p.roleDefs.map((rd) => html`<div class="person"><span class=${`dot ${rd.agent === "codex" ? "cx" : "ag"}`}><${Icon} name="agent" /></span><span><b>${rd.name}</b><small>${roleLine(rd)}</small></span></div>`)}
          ${human && html`<div class="person"><span class="dot hu"><${Icon} name="you" /></span><span><b>${t("You")}</b><small>${t("proc.youDo")}</small></span></div>`}
        </div></section>`}
        ${p.entries.length > 0 && html`<section><h2>${t("proc.how")} <span class="muted small hint">— ${t("read.hint")}</span></h2>
          <ol class="steps">${p.entries.map((e, i) => html`<${ProcessEntry} e=${e} i=${i} p=${p} on=${i === at} key=${e.id} />`)}</ol>
          ${p.repeat && html`<p class="loop"><${Icon} name="again" />${t("proc.again")}</p>`}
        </section>`}
      </div>
      ${at >= 0 && html`<${StepPanel} p=${p} i=${at} key=${p.entries[at].id} />`}
    </div>`;
}

function ProcessEntry({ e, i, p, on }) {
  const { icon, dot } = look(e);
  const badges = entryBadges(e);
  return html`<li><a class=${`pstep${e.kind === "action" ? " sys" : ""}${e.detour ? " det" : ""}${on ? " on" : ""}`}
      href=${stepHref(p.name, e.id)} aria-current=${on ? "step" : undefined}>
    <span class="num">${i + 1}</span>
    <span class=${`dot ${dot}`}><${Icon} name=${icon} /></span>
    <span class="stp">
      <span>${roleChip(e)}${entryPhrase(e)}${e.detour ? html` <${Pill} tone="calm">${t("run.onlyIfNeeded")}<//>` : ""}</span>
      ${badges.length > 0 && html`<span class="badges">${badges.map((b) => html`<span class=${`badge ${b.tone}`}>${b.text}</span>`)}</span>`}
      ${entryBranch(e, p.entries).map((b) => html`<span class="branch small">${b}</span>`)}
    </span>
  </a></li>`;
}

function StepPanel({ p, i }) {
  const e = p.entries[i];
  const { data: step } = useData(e.step ? `/api/steps/${enc(e.step)}` : null, false);
  const { data: steps } = useData(e.step ? "/api/steps" : null, false);
  useEffect(() => {
    const on = (ev) => { if (ev.key === "Escape") go("process", p.name); };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [p.name]);
  const { icon, dot } = look(e);
  const prev = p.entries[i - 1], next = p.entries[i + 1];
  const usedBy = ((steps || []).find((s) => s.id === e.step) || { usedBy: [] }).usedBy.filter((x) => x !== p.name);
  const short = (x) => { const s = x.step || entryPhrase(x); return s.length > 28 ? `${s.slice(0, 27)}…` : s; };
  return html`<aside class="panel" aria-label=${t("read.panel")}>
    <div class="phead">
      <div class="prow"><span class="small muted grow">${t("read.of", { n: i + 1, total: p.entries.length })}${e.step ? html` · <span class="mono">${e.step}</span>` : ""}</span>
        <a class="x" href=${`#/process/${enc(p.name)}`} aria-label=${t("act.close")}><${Icon} name="close" /></a></div>
      <div class="ptitle"><span class=${`dot ${dot}`}><${Icon} name=${icon} /></span>
        <div><span class="small muted">${entryWho(e, p.roleDefs)}</span><h2>${entryPhrase(e)}</h2></div></div>
    </div>
    <div class="pbody">
      <section><h3>${t("read.how")}</h3>
        <dl class="how">${entryFacts(e, p.roleDefs).map((f) => html`<dt>${f.k}</dt><dd class=${f.mono ? "mono" : ""}>${f.v}</dd>`)}</dl>
        ${entryBranch(e, p.entries).map((b) => html`<p class="branch small">${b}</p>`)}
      </section>
      ${e.step && html`<section>${step
        ? html`<${Prompt} step=${e.step} text=${step.body} head=${t(e.kind === "human" ? "proc.toldHuman" : "proc.told")} />`
        : html`<p class="muted">${t("loading")}</p>`}</section>`}
      <section><h3>${t("read.where")}</h3>
        ${step && html`<${PathRow} label=${t("read.stepFile")} path=${step.path} />`}
        <${PathRow} label=${t("read.procFile", { n: i + 1 })} path=${p.path} />
        ${e.step && html`<p class="small muted">${usedBy.length ? t("proc.usedIn", { list: usedBy.join(", ") }) : t("proc.usedNowhere")}${" "}
          <a href="#/step/${enc(e.step)}">${t("act.editText")}</a></p>`}
      </section>
    </div>
    <div class="pfoot">
      ${prev ? html`<a class="btn quiet sm" href=${stepHref(p.name, prev.id)}>‹ ${i} · ${short(prev)}</a>` : html`<span></span>`}
      ${next && html`<a class="btn quiet sm" href=${stepHref(p.name, next.id)}>${i + 2} · ${short(next)} ›</a>`}
    </div>
  </aside>`;
}

function PathRow({ label, path }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(path).then(() => setCopied(true), () => {});
  return html`<div class="path"><span class="mono grow"><small>${label}</small>${path}</span>
    <button class="btn sm" onClick=${copy}><${Icon} name="copy" size=${16} />${t(copied ? "act.copied" : "act.copy")}</button></div>`;
}

/** A step's text as written, and — in a language other than English — a button that has flowd translate it. */
function Prompt({ step, text, head }) {
  const lang = getLang();
  const [tr, setTr] = useState(null); // null, "busy" or {text}
  const [show, setShow] = useState("tr");
  const [err, setErr] = useState(null);
  const translate = attempt(async () => {
    setTr("busy");
    try {
      setTr(await api("POST", `/api/steps/${enc(step)}/translate`, { lang }));
    } catch (e) {
      setTr(null);
      throw e;
    }
  }, setErr);
  const done = tr && tr !== "busy";
  const seg = (k, label) => html`<button class=${show === k ? "on" : ""} aria-pressed=${show === k} onClick=${() => setShow(k)}>${label}</button>`;
  return html`<div class="prompt">
    <div class="prow">${head && html`<h3 class="grow">${head}</h3>`}
      ${lang !== "en" && !tr && html`<button class="btn sm" onClick=${translate}><${Icon} name="translate" size=${18} />${t("read.translate")}</button>`}
      ${done && html`<div class="seg" role="group" aria-label=${t("read.textLang")}>${seg("tr", t("read.translation"))}${seg("orig", t("read.original"))}</div>`}
    </div>
    <${Err} msg=${err} />
    ${tr === "busy" && html`<p class="busy"><span class="spin" aria-hidden="true"></span>${t("read.translating")}</p>`}
    ${done && show === "tr" ? html`<pre class="instr tr">${tr.text}</pre><p class="small muted">${t("read.byLuna")}</p>` : html`<pre class="instr">${text}</pre>`}
  </div>`;
}
```

Drop the `useData("/api/steps", false)` call `ProcessView` no longer uses. If `Pill`, `roleChip`, `runName`, `DefErrors`, `Loading` are defined below `ProcessView`, nothing changes: they are module-level consts used at render time.

- [ ] **Step 5: The run page** — `PromptFold` gets the step id and the Translate control. Its caller in `Current`:

```js
    ${(e.kind === "agent" || e.kind === "human") && html`<${PromptFold} run=${r.id} entry=${e.id} step=${e.step} label=${e.kind === "agent" ? t("run.toldAgent") : t("proc.toldHuman")} />`}
```

and `PromptFold`:

```js
function PromptFold({ run, entry, step, label }) {
  const [on, setOn] = useState(false);
  const { data, error } = useData(on ? `/api/runs/${enc(run)}/entries/${enc(entry)}/prompt` : null, false);
  return html`<details class="more" onToggle=${(ev) => setOn(ev.currentTarget.open)}><summary>${label}</summary>
    ${data ? (step ? html`<${Prompt} step=${step} text=${data.text} />` : html`<pre class="instr">${data.text}</pre>`)
      : error ? html`<p class="err-box">${error.message}</p>` : on && html`<p class="muted">${t("loading")}</p>`}
  </details>`;
}
```

(The translation is of the step's text, `{{…}}` included, not of the filled-in prompt: the spec says so.)

- [ ] **Step 6: Styles** — append to `ui/style.css` before the first `@media (max-width: 640px)` block of the processes section (after `.form { gap: 16px; }`):

```css
/* reading a process: entries on the left, the chosen one in a panel on the right */
.read { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
.readl { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 28px; }
.hint { font-weight: 400; }
a.pstep { color: inherit; text-decoration: none; grid-template-columns: 28px 36px minmax(0, 1fr); }
a.pstep:hover { border-color: var(--accent); }
a.pstep.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.badge { padding: 2px 9px; border-radius: 999px; font-size: 13px; font-weight: 500; background: var(--chip); color: var(--muted); }
.badge.hold { background: var(--you-soft); color: var(--you-text); }
.dot.cx { background: var(--ok-soft); color: var(--ok-text); }
.panel { flex: 1 1 440px; max-width: 560px; position: sticky; top: 16px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  background: var(--box); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 10px 30px rgb(0 0 0 / 0.08); overflow: hidden; }
.phead { padding: 16px 20px 14px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
.phead h2 { font-size: 18px; line-height: 1.35; margin: 2px 0 0; color: var(--fg); overflow-wrap: anywhere; }
.prow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.ptitle { display: flex; gap: 12px; align-items: flex-start; }
.ptitle > div { min-width: 0; }
.pbody { padding: 16px 20px 20px; overflow: auto; display: flex; flex-direction: column; gap: 22px; }
.pbody h3 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.pfoot { border-top: 1px solid var(--line); padding: 8px 12px; display: flex; justify-content: space-between; gap: 8px; }
.x { width: 44px; height: 44px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
.x:hover { background: var(--chip); }
.how { display: grid; grid-template-columns: minmax(110px, max-content) minmax(0, 1fr); gap: 8px 16px; margin: 0 0 8px; }
.how dt { color: var(--muted); font-size: 14px; }
.how dd { margin: 0; overflow-wrap: anywhere; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; background: var(--box); color: var(--muted); font: inherit; font-size: 13px; font-weight: 600; padding: 0 12px; min-height: 36px; cursor: pointer; }
.seg button.on { background: var(--fg); color: var(--bg); }
.instr.tr { font-family: inherit; font-size: 15px; line-height: 1.6; background: var(--accent-soft); color: var(--fg); }
.busy { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-top: 10px; border-radius: 12px; background: var(--accent-soft); color: var(--accent-text); font-weight: 500; }
.spin { width: 18px; height: 18px; border-radius: 50%; border: 2.5px solid var(--line); border-top-color: var(--accent); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.path { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.path .mono { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.path small { display: block; color: var(--muted); font-size: 12px; font-family: inherit; }
.btn.sm { min-height: 36px; padding: 0 12px; font-size: 14px; }
.grow { flex: 1 1 auto; }
/* below this the list and the panel do not fit side by side: the panel takes the screen */
@media (max-width: 960px) {
  .read.open .panel { position: fixed; inset: 0; max-width: none; max-height: none; border-radius: 0; border: 0; z-index: 20; }
}
@media (max-width: 640px) {
  a.pstep { grid-template-columns: 36px minmax(0, 1fr); }
  .how { grid-template-columns: 1fr; gap: 2px; }
  .how dt { margin-top: 8px; }
  .hint { display: none; }
}
```

Before adding, check `ui/style.css` for existing `.mono`, `.grow`, `.btn.sm` and `.x`: reuse an existing rule instead of adding a second one. If `.instr` uses a monospace font through another selector, keep `.instr.tr`'s `font-family: inherit` so the translation reads as prose.

- [ ] **Step 7: The preview** — in `scripts/ui-preview.ts`'s `files`, add a process with every kind of entry:

```ts
  "steps/deliver.md": step("The dev deploys the PR branch to the test desk", "Deploy the PR branch to the shared test desk with `desk deploy {{vars.pr}}`.\nWait until the desk answers on /health with the PR's head sha.\n\nDone: `flow done --note \"<sha>\"`."),
  "steps/feedback.md": step("The dev reacts to the team's review; done once approved and green", "A review arrived on {{vars.pr}}. Read every comment. Fix what is right, answer what is not,\nresolve each thread you handled. Push, then ask for a new look.\n\nApproved and green: `flow done`. Changes requested again: `flow failed` — flows waits for the next review."),
  "processes/pr-full.yaml": `description: Take a finished branch to merge — PR, the shared test desk, CI, team review
cwd: /tmp
max_runs: 3
roles:
  dev: {spawn: claude}
  peer: {spawn: codex, beside: dev}
steps:
  - {id: codex, do: type, role: peer, text: ""}
  - {step: open-pr, role: dev}
  - {step: deliver, role: dev, timeout: 1h, hold: desk}
  - {id: ci, wait_for: gh.checks, on_fail: {goto: ci-fix}}
  - {step: ci-fix, role: dev}
  - {id: label, sh: 'gh pr edit "$FLOW_VAR_PR" --add-label ready', timeout: 5m}
  - {step: feedback, role: dev, wait_for: {on: gh.review, with: {from: requested, already: true}}, on_fail: retry, retries: 50}
  - {inner: true, role: dev}
  - {step: merge, role: human, wait_for: gh.merged}
  - {id: tail, wait: 20h}
  - {step: hello, role: dev, on_fail: end}
`,
```

If validation refuses an entry (for example `text: ""` or `gh.review`'s `with` on the stub plugin), adjust that entry so `pr-full` is valid and still has one entry of each kind; the preview page must show it without the error box.

- [ ] **Step 8: Check it by hand**

Run: `npm test && npm run typecheck`, then `node scripts/ui-preview.ts` and open `http://127.0.0.1:7421/#/process/pr-full`:
- RU: every card shows its badges; Claude/Codex and "в правой половине рядом с dev" under the roles;
- click each entry: the panel shows its facts; shell shows the command; inner, pause and type read as sentences; Esc and × close it; browser Back closes it; ‹ › move;
- `deliver`: Translate shows the spinner, then "[RU] …" with the Перевод/Оригинал switch; Copy changes to "Скопировано";
- EN: no Translate button;
- 1280 px: panel beside the list, sticky; 900 px and 390/320 px: the panel takes the screen, no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`);
- dark theme (`?theme=dark`): badges, panel and translation readable;
- a run page: "What the agent is told" has Translate.

- [ ] **Step 9: Commit**

```bash
git add ui/lib.js ui/app.js ui/style.css ui/text.js scripts/ui-preview.ts
git commit -m "feat(ui): read a process — each step in a side panel, its prompt translatable"
```

---

### Task 5: Documentation, ship

**Files:**
- Modify: `README.md` (the web UI bullet)
- Modify: `docs/backlog/*` only if a residual is left

- [ ] **Step 1:** In `README.md`, extend the web UI bullet: a process page explains each step in a side panel — what it waits for, what it holds, its limits, where its files are — and translates a step's prompt into Russian with a local Codex model.
- [ ] **Step 2:** `grep -rn "StepFold\|/api/steps/:id\b" docs README.md skills` — fix anything that describes the old process page or misses the new route.
- [ ] **Step 3:** `npm test && npm run typecheck` — PASS.
- [ ] **Step 4: Commit, restart, push**

```bash
git add README.md
git commit -m "docs: reading a process and translating a step in the README"
launchctl kickstart -k gui/$UID/local.flows
```

Then the privacy scan of `git log origin/main..HEAD -p` (names, logins, employer or product names, private repos, ticket numbers, home paths) and `git push origin main`.
- [ ] **Step 5:** On the real flowd: the largest PR process and a process with `beside` roles, a shell entry and `inner` read correctly; Translate on a long step returns Russian through Luna within ~15 s; a second click answers at once.

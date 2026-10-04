import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_EVENTS, ENTRY_KEYS, PROCESS_KEYS } from "../src/defs.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Living docs only: specs and plans are records and may name files that later moved. */
function markdownFiles(): string[] {
  const top = ["README.md", "CONTRIBUTING.md", "CLAUDE.md"].filter((f) => existsSync(join(ROOT, f)));
  const docs = readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
  const skills = readdirSync(join(ROOT, "skills")).map((d) => `skills/${d}/SKILL.md`).filter((f) => existsSync(join(ROOT, f)));
  return [...top, ...docs, ...skills];
}

test("relative links in the living docs resolve", () => {
  const broken: string[] = [];
  for (const file of markdownFiles()) {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!existsSync(join(ROOT, dirname(file), decodeURIComponent(target)))) broken.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("docs/processes.md documents every key the loader accepts", () => {
  const doc = read("docs/processes.md");
  const keys = [...PROCESS_KEYS, ...ENTRY_KEYS, "summary", "spawn", "cwd", "cron", "on", "where", "with"];
  assert.deepEqual(keys.filter((k) => !doc.includes(`\`${k}\``)), []);
});

test("docs/cli.md documents every flow command", () => {
  const cmds = [...read("src/cli.ts").matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]).filter((c) => c !== "help");
  const missing = [...new Set([...cmds, "agterm-hook", "claude-hook"])].filter((c) => !read("docs/cli.md").includes(`flow ${c}`));
  assert.deepEqual(missing, []);
});

test("docs/concepts.md lists every core event", () => {
  const doc = read("docs/concepts.md");
  assert.deepEqual(CORE_EVENTS.filter((e) => !doc.includes(e)), []);
});

test("every skill names itself and says when to use it", () => {
  for (const dir of readdirSync(join(ROOT, "skills"))) {
    const text = read(`skills/${dir}/SKILL.md`);
    assert.match(text, new RegExp(`^---\\n(?:.*\\n)*?name: ${dir}\\n(?:.*\\n)*?---`), dir);
    assert.match(text, /\ndescription: .{40,}\n/, dir);
  }
});

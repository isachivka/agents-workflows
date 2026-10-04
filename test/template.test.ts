import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, RenderError } from "../src/template.ts";

test("substitutes nested paths", () => {
  const out = renderTemplate("run {{run.id}} pr {{ vars.pr }}", { run: { id: "p#1" }, vars: { pr: "u" } });
  assert.equal(out, "run p#1 pr u");
});

test("objects render as JSON, numbers as text", () => {
  assert.equal(renderTemplate("{{a}} {{b}}", { a: { x: 1 }, b: 2 }), '{"x":1} 2');
});

test("a missing value is a RenderError naming the placeholder", () => {
  assert.throws(() => renderTemplate("x {{vars.nope}}", { vars: {} }), (e: unknown) => e instanceof RenderError && /vars\.nope/.test((e as Error).message));
});

test("text without placeholders is unchanged", () => {
  assert.equal(renderTemplate("plain `code` $HOME", {}), "plain `code` $HOME");
});

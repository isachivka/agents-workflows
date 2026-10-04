import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefs } from "../src/defs.ts";
import { PluginHost } from "../src/plugins.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the shipped examples are valid against the built-in plugins", async () => {
  const host = new PluginHost({ dirs: [join(ROOT, "plugins")], config: {}, sink: () => {}, log: () => {} });
  await host.load();
  const defs = loadDefs(join(ROOT, "examples"), host.eventTypes(), host.actionNames());
  assert.deepEqual(defs.invalid, {});
  assert.deepEqual(Object.keys(defs.processes).sort(), ["demo", "pr-loop"]);
});

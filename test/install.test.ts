import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "../src/install.ts";

function fakeBin(dir: string, name: string): { path: string; calls: () => string } {
  const log = join(dir, `${name}.log`);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("install wires launchd, agterm and Claude hooks, the skill and the PATH link — idempotently", async () => {
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "s" }] }] } }));
  const launchctl = fakeBin(home, "launchctl");
  const agtermctl = fakeBin(home, "agtermctl");
  const opts = { home, repo: "/repo", node: "/bin/node", launchctl: launchctl.path, agtermctl: agtermctl.path, uid: 501, log: () => {} };
  await install(opts);
  await install(opts);

  const plistPath = join(home, "Library", "LaunchAgents", "local.flows.plist");
  const plistText = readFileSync(plistPath, "utf8");
  assert.match(plistText, /<string>local\.flows<\/string>/);
  assert.match(plistText, /<string>\/bin\/node<\/string>\s*<string>\/repo\/src\/cli\.ts<\/string>\s*<string>daemon<\/string>/);
  assert.deepEqual(launchctl.calls().split("\n").filter(Boolean), [
    "bootout gui/501/local.flows", `bootstrap gui/501 ${plistPath}`,
    "bootout gui/501/local.flows", `bootstrap gui/501 ${plistPath}`,
  ]);

  const hooks = readFileSync(join(home, ".config", "agterm", "hooks.conf"), "utf8");
  assert.equal(hooks, "on status '/bin/node' '/repo/src/cli.ts' agterm-hook\non session.closed '/bin/node' '/repo/src/cli.ts' agterm-hook\n");
  assert.equal(agtermctl.calls(), "hooks reload\nhooks reload\n");

  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "x");
  assert.deepEqual(settings.hooks.PostCompact, [{ hooks: [{ type: "command", command: "'/bin/node' '/repo/src/cli.ts' claude-hook compacted" }] }]);
  // turn signals for zmx sessions; outside one ($FLOW_SESSION unset) the shell skips node altogether
  const turn = (event: string) => ({ type: "command", command: `[ -z "$FLOW_SESSION" ] || '/bin/node' '/repo/src/cli.ts' claude-hook ${event}` });
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [turn("start")] }]);
  assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [turn("active")] }]);
  assert.deepEqual(settings.hooks.PostToolUse, [{ hooks: [turn("active")] }]);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: "s" }] }, { hooks: [turn("completed")] }]);
  assert.deepEqual(settings.hooks.Notification, [{ matcher: "permission_prompt", hooks: [turn("blocked")] }, { matcher: "idle_prompt", hooks: [turn("idle")] }]);
  assert.ok(existsSync(join(home, ".claude", "settings.json.bak-flows")));

  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow")), "/repo/skills/flow");
  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow-author")), "/repo/skills/flow-author");
  assert.equal(readlinkSync(join(home, ".local", "bin", "flow")), "/repo/bin/flow");
});

// nvm puts the node version in its path; after an upgrade a re-install must replace flows'
// hook lines, not add a second set next to dead ones.
test("a re-install with another node replaces flows' hooks instead of adding to them", async () => {
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  mkdirSync(join(home, ".config", "agterm"), { recursive: true });
  writeFileSync(join(home, ".config", "agterm", "hooks.conf"), "# mine\non status echo hi\n");
  const opts = { home, repo: "/repo", launchctl: fakeBin(home, "launchctl").path, agtermctl: fakeBin(home, "agtermctl").path, uid: 501, log: () => {} };
  await install({ ...opts, node: "/a/node" });
  await install({ ...opts, node: "/b/node" });
  assert.equal(readFileSync(join(home, ".config", "agterm", "hooks.conf"), "utf8"),
    "# mine\non status echo hi\non status '/b/node' '/repo/src/cli.ts' agterm-hook\non session.closed '/b/node' '/repo/src/cli.ts' agterm-hook\n");
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.PostCompact, [{ hooks: [{ type: "command", command: "'/b/node' '/repo/src/cli.ts' claude-hook compacted" }] }]);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: `[ -z "$FLOW_SESSION" ] || '/b/node' '/repo/src/cli.ts' claude-hook completed` }] }]);
});

test("an install from before the skills/ move gets its skill link replaced", async () => {
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync("/repo/skill/flow", join(home, ".claude", "skills", "flow"));
  await install({ home, repo: "/repo", node: "/bin/node", launchctl: fakeBin(home, "launchctl").path, agtermctl: fakeBin(home, "agtermctl").path, uid: 501, log: () => {} });
  assert.equal(readlinkSync(join(home, ".claude", "skills", "flow")), "/repo/skills/flow");
});

test("a re-install keeps FLOWD_HOST from the old plist", async () => {
  delete process.env.FLOWD_HOST;
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  const launchctl = fakeBin(home, "launchctl");
  const agtermctl = fakeBin(home, "agtermctl");
  const opts = { home, repo: "/repo", node: "/bin/node", launchctl: launchctl.path, agtermctl: agtermctl.path, uid: 501, log: () => {} };
  await install(opts);
  const plistPath = join(home, "Library", "LaunchAgents", "local.flows.plist");
  assert.doesNotMatch(readFileSync(plistPath, "utf8"), /FLOWD_HOST/);
  // the layout plutil -insert leaves: key and value on lines of their own
  writeFileSync(plistPath, readFileSync(plistPath, "utf8").replace("</string></dict>", "</string>\n\t\t<key>FLOWD_HOST</key>\n\t\t<string>0.0.0.0</string>\n\t</dict>"));
  await install(opts);
  assert.match(readFileSync(plistPath, "utf8"), /<key>FLOWD_HOST<\/key><string>0\.0\.0\.0<\/string>/);
});

test("a bootstrap refused right after bootout is retried", async () => {
  delete process.env.FLOWD_HOST;
  const home = mkdtempSync(join(tmpdir(), "flows-install-"));
  const log = join(home, "launchctl.log");
  const launchctl = join(home, "launchctl");
  // refuses the first bootstrap, as launchd does while the old service is still going away
  writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = bootstrap ] && [ ! -f '${log}.once' ]; then touch '${log}.once'; echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi\n`);
  chmodSync(launchctl, 0o755);
  const agtermctl = fakeBin(home, "agtermctl");
  const said: string[] = [];
  await install({ home, repo: "/repo", node: "/bin/node", launchctl, agtermctl: agtermctl.path, uid: 501, log: (s: string) => said.push(s), retryMs: 1 });
  const plistPath = join(home, "Library", "LaunchAgents", "local.flows.plist");
  assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), ["bootout gui/501/local.flows", `bootstrap gui/501 ${plistPath}`, `bootstrap gui/501 ${plistPath}`]);
  assert.ok(!said.some((s) => /Bootstrap failed/.test(s)), said.join("\n"));
});

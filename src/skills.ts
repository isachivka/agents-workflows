import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Which kind of agent a role's spawn command runs: how it is told about skills. */
export const agentOf = (spawn: string): "claude" | "codex" | "other" => {
  const bin = basename(spawn.trim().split(/\s+/)[0] ?? "");
  return bin === "claude" ? "claude" : bin === "codex" ? "codex" : "other";
};

/**
 * The SKILL.md (or command file) a Claude agent working in `cwd` would load for `name`: the
 * project's, then the user's, then, for `plugin:skill`, the installed plugin's. Null when none.
 */
export function claudeSkillFile(name: string, cwd: string, claudeDir: string): string | null {
  const plugin = /^([^:]+):(.+)$/.exec(name);
  if (plugin) {
    let installs: Record<string, { installPath?: string }[]> = {};
    try { installs = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {}; } catch { /* none */ }
    const roots = Object.entries(installs).filter(([k]) => k.split("@")[0] === plugin[1]).flatMap(([, v]) => v.map((i) => i.installPath ?? ""));
    return roots.flatMap((r) => [join(r, "skills", plugin[2], "SKILL.md"), join(r, "commands", `${plugin[2]}.md`)]).find((p) => existsSync(p)) ?? null;
  }
  return [join(cwd, ".claude"), claudeDir].flatMap((d) => [join(d, "skills", name, "SKILL.md"), join(d, "commands", `${name}.md`)]).find((p) => existsSync(p)) ?? null;
}

/**
 * How a step's skills are named in the line typed to the agent, so they reach it as the person's own
 * words, not as tool output: Claude gets each file attached (`@path`, which Claude Code inlines into the
 * message), or `/name` when no file is found; Codex gets `$name`, which loads the skill.
 */
export function skillRefs(names: string[], agent: "claude" | "codex" | "other", cwd: string, claudeDir: string): string[] {
  return names.map((n) => {
    if (agent === "codex") return `$${n}`;
    const file = agent === "claude" ? claudeSkillFile(n, cwd, claudeDir) : null;
    return file ? `@${file}` : `/${n}`;
  });
}

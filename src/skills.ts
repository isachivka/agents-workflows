import { basename } from "node:path";

/** Which kind of agent a role's spawn command runs: how it is told about skills. */
export const agentOf = (spawn: string): "claude" | "codex" | "other" => {
  const bin = basename(spawn.trim().split(/\s+/)[0] ?? "");
  return bin === "claude" ? "claude" : bin === "codex" ? "codex" : "other";
};

/**
 * How a step's skills are named in the line typed to the agent, so they reach it as the person's own
 * words, not inside tool output: `$name` for Codex, `/name` for Claude and the rest.
 */
export const skillRefs = (names: string[], agent: "claude" | "codex" | "other"): string[] =>
  names.map((n) => (agent === "codex" ? `$${n}` : `/${n}`));

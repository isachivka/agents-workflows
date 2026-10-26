import { basename } from "node:path";
import { shq } from "./agterm.ts";

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

/**
 * The skills a step line names. Codex always gets `$flow` first: Claude takes the flow skill up by
 * itself on a `▶ flow:` line, Codex is told (and again after a `/clear`).
 */
export const lineSkills = (names: string[], agent: "claude" | "codex" | "other"): string[] =>
  skillRefs(agent === "codex" ? [...new Set(["flow", ...names])] : names, agent);

/**
 * The spawn command as flowd runs it. Codex gets `--no-daemon`: by default its tool commands (and
 * hooks) run in a shared background server that keeps the environment of whichever session started
 * it, so `flow` in a Codex agent saw another session's `AGTERM_SESSION_ID` (seen live).
 */
/** The spawn that reopens an agent's conversation: Claude's `--resume <id>`, Codex's `resume <id>`. */
export const resumeSpawn = (spawn: string, agent: "claude" | "codex", id: string): string =>
  agent === "claude" ? `${spawn} --resume ${shq(id)}` : `${agentSpawn(spawn)} resume ${shq(id)}`;

export const agentSpawn = (spawn: string): string =>
  agentOf(spawn) === "codex" && !/(^|\s)--no-daemon(\s|$)/.test(spawn) ? spawn.replace(/^(\s*\S+)/, "$1 --no-daemon") : spawn;

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** A Claude Code session on disk: what `claude --resume <id>` takes, and where it ran. */
export interface ClaudeSession { id: string; cwd: string; at: number }

const textOf = (content: unknown): string[] =>
  typeof content === "string" ? [content]
    : Array.isArray(content) ? content.flatMap((b) => (b && b.type === "text" && typeof b.text === "string" ? [b.text] : [])) : [];

/**
 * The Claude session a role of a run talked in, found in Claude Code's transcripts
 * (`<root>/<project>/<session>.jsonl`): the latest one that was typed a step line of this run for one
 * of the role's entries. Only the person's turns count, so a line quoted in a tool result or by a
 * subagent does not. Files last written before `since` are not read.
 */
export async function findClaudeSession(root: string, run: string, entries: string[], since: number): Promise<ClaudeSession | null> {
  const marker = ` · ${run} it.`;
  const line = new RegExp(`^▶ flow: step (\\S+) · ${run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} it\\.\\d+`);
  let best: ClaudeSession | null = null;
  const projects = await readdir(root).catch(() => [] as string[]);
  for (const project of projects) {
    const files = await readdir(join(root, project)).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith(".jsonl"))) {
      const path = join(root, project, f);
      const st = await stat(path).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      const text = await readFile(path, "utf8").catch(() => "");
      if (!text.includes(marker)) continue;
      for (const raw of text.split("\n")) {
        if (!raw.includes(marker)) continue;
        let o: { type?: string; isSidechain?: boolean; sessionId?: string; cwd?: string; timestamp?: string; message?: { content?: unknown } };
        try { o = JSON.parse(raw); } catch { continue; }
        if (o.type !== "user" || o.isSidechain || !o.sessionId || !o.cwd) continue;
        const told = textOf(o.message?.content).some((t) => entries.includes(line.exec(t)?.[1] ?? ""));
        const at = Date.parse(o.timestamp ?? "") || st.mtimeMs;
        if (told && (!best || at > best.at)) best = { id: o.sessionId, cwd: o.cwd, at };
      }
    }
  }
  return best;
}

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefs } from "./defs.ts";
import { PluginHost } from "./plugins.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Validates a FLOWS_HOME the way flowd loads it, without flowd. */
export async function checkDefs(home: string, name?: string, pluginDirs = [join(REPO, "plugins"), join(home, "plugins")]): Promise<{ ok: boolean; lines: string[] }> {
  const host = new PluginHost({ dirs: pluginDirs, config: {}, sink: () => {}, log: () => {} });
  await host.load();
  const defs = loadDefs(home, host.eventTypes(), host.actionNames());
  const lines: string[] = [];
  if (!name) for (const [plugin, err] of Object.entries(host.loadErrors)) lines.push(`plugin ${plugin}: ${err}`);
  for (const [key, errors] of Object.entries(defs.invalid)) {
    const [kind, id] = key.split(":");
    if (name && id !== name) continue;
    for (const e of errors) lines.push(`${kind} ${id}: ${e}`);
  }
  if (name && !lines.length && !defs.processes[name] && !defs.steps[name]) lines.push(`no process or step named ${name}`);
  if (lines.length) return { ok: false, lines };
  const processes = Object.keys(defs.processes).length;
  const steps = Object.keys(defs.steps).length;
  return { ok: true, lines: [name ? `${name} is valid` : `${processes} process(es) and ${steps} step(s) are valid`] };
}

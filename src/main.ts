import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realAgterm } from "./agterm.ts";
import { Flowd } from "./daemon.ts";
import { flowsHome } from "./defs.ts";
import { makeServer } from "./http.ts";
import { createServer } from "node:http";
import { statePath } from "./store.ts";
import { zmxTerminal } from "./zmx.ts";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** FLOWS_ZMX, else zmx on PATH, else the one agterm ships (it has the `type` and `screen` flows uses). */
function zmxBin(): string {
  if (process.env.FLOWS_ZMX) return process.env.FLOWS_ZMX;
  const found = [...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "zmx")), "/Applications/agterm.app/Contents/MacOS/zmx"].find(existsSync);
  return found ?? "zmx";
}

export async function startDaemon(): Promise<void> {
  const home = flowsHome();
  const zmx = zmxTerminal({ bin: zmxBin(), dir: process.env.FLOWS_ZMX_DIR || join(dirname(statePath()), "zmx") });
  const f = new Flowd({ home, statePath: statePath(), agterm: realAgterm(), zmx, pluginDirs: [join(REPO, "plugins"), join(home, "plugins")],
    // step prompts are translated ahead of time into these (comma-separated; empty turns it off)
    pretranslate: (process.env.FLOWS_PRETRANSLATE ?? "ru").split(",").map((l) => l.trim()).filter(Boolean),
    // agents' reports, served on their own port for the router's reverse proxy; off without a public base
    ...(process.env.FLOWS_REPORTS_URL ? { reports: { dir: join(dirname(statePath()), "reports"), url: process.env.FLOWS_REPORTS_URL } } : {}) });
  await f.init();
  const port = Number(process.env.FLOWD_PORT || 7420);
  const host = process.env.FLOWD_HOST || "127.0.0.1";
  const server = makeServer(f, join(REPO, "ui"), { lan: host !== "127.0.0.1" && host !== "localhost", publicUrl: process.env.FLOWD_PUBLIC_URL || undefined });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.error(`[flowd] http://${host}:${port} · FLOWS_HOME ${home} · state ${statePath()}`);
  // nothing but the reports on this listener: it is the one the outside reaches
  const reports = f.reports ? createServer((req, res) => f.reports!.handler(req, res)) : undefined;
  if (reports) {
    const rPort = Number(process.env.FLOWS_REPORTS_PORT || 7430);
    const rHost = process.env.FLOWS_REPORTS_HOST || "0.0.0.0";
    await new Promise<void>((resolve, reject) => {
      reports.once("error", reject);
      reports.listen(rPort, rHost, resolve);
    });
    console.error(`[flowd] reports on http://${rHost}:${rPort}, linked as ${process.env.FLOWS_REPORTS_URL}`);
  }
  const stop = async () => {
    reports?.closeAllConnections();
    reports?.close();
    server.closeAllConnections();
    server.close();
    await f.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

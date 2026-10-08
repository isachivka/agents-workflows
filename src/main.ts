import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realAgterm } from "./agterm.ts";
import { Flowd } from "./daemon.ts";
import { flowsHome } from "./defs.ts";
import { makeServer } from "./http.ts";
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
  const f = new Flowd({ home, statePath: statePath(), agterm: realAgterm(), zmx, pluginDirs: [join(REPO, "plugins"), join(home, "plugins")] });
  await f.init();
  const port = Number(process.env.FLOWD_PORT || 7420);
  const host = process.env.FLOWD_HOST || "127.0.0.1";
  const server = makeServer(f, join(REPO, "ui"), { lan: host !== "127.0.0.1" && host !== "localhost" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.error(`[flowd] http://${host}:${port} · FLOWS_HOME ${home} · state ${statePath()}`);
  const stop = async () => {
    server.closeAllConnections();
    server.close();
    await f.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

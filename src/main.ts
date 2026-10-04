import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realAgterm } from "./agterm.ts";
import { Flowd } from "./daemon.ts";
import { flowsHome } from "./defs.ts";
import { makeServer } from "./http.ts";
import { statePath } from "./store.ts";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function startDaemon(): Promise<void> {
  const home = flowsHome();
  const f = new Flowd({ home, statePath: statePath(), agterm: realAgterm(), pluginDirs: [join(REPO, "plugins"), join(home, "plugins")] });
  await f.init();
  const port = Number(process.env.FLOWD_PORT || 7420);
  const server = makeServer(f, join(REPO, "ui"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.error(`[flowd] http://127.0.0.1:${port} · FLOWS_HOME ${home} · state ${statePath()}`);
  const stop = async () => {
    server.closeAllConnections();
    server.close();
    await f.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

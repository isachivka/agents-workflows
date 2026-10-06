import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { makeServer } from "../src/http.ts";
import { makeHome, startFlowd } from "./daemon-helpers.ts";
import type { FlowdOptions } from "../src/daemon.ts";

// A test that fails before its own close() would leave the server listening and hang the file.
const open = new Set<() => Promise<void>>();
after(() => Promise.all([...open].map((c) => c())));

export async function serve(files: Record<string, string>, opts: Partial<FlowdOptions> = {}, http: { lan?: boolean } = {}) {
  const home = makeHome(files);
  const { f, agterm, clock } = await startFlowd(home, opts);
  const ui = mkdtempSync(join(tmpdir(), "flows-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>flows</title>");
  writeFileSync(join(ui, "app.js"), "export {};\n");
  const server = makeServer(f, ui, http);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, type: res.headers.get("content-type") ?? "" };
  };
  const close = async () => {
    if (!open.delete(close)) return;
    server.closeAllConnections();
    server.close();
    await f.close();
  };
  open.add(close);
  return { f, agterm, clock, home, base, call, close, ui };
}

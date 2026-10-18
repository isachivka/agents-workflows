import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ends a detached child and everything it started; it may have exited already. */
export function killGroup(c: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (c.pid) process.kill(-c.pid, signal);
  } catch {
    c.kill(signal);
  }
}

/** SIGTERM now, SIGKILL after a grace: something in the group may ignore SIGTERM. */
function stopGroup(c: ChildProcess): void {
  killGroup(c);
  setTimeout(() => killGroup(c, "SIGKILL"), 1000).unref();
}

const LANG_NAMES: Record<string, string> = { ru: "Russian", en: "English" };

export const instruction = (lang: string): string =>
  `Translate the text on stdin into ${LANG_NAMES[lang] ?? lang}. Keep code, commands, shell snippets, {{placeholders}}, ` +
  "URLs, file paths and Markdown exactly as they are. Output only the translation, nothing else.";

export interface TranslatorOptions {
  /** the command; the instruction is appended as its last argument and the text goes to stdin */
  argv: string[];
  /** where translations are cached, one file per command, instruction and text */
  dir: string;
  timeoutMs: number;
  /** how many may run at once; the rest wait in line */
  max: number;
}

/** Translates a step's text for the person reading it, with a local command (Codex by default). */
export class Translator {
  private o: TranslatorOptions;
  private running = 0;
  private waiting: (() => void)[] = [];
  private pending = new Map<string, Promise<string>>();
  // each running child with the function that settles its request at once
  private children = new Map<ChildProcess, () => void>();
  private closed = false;

  constructor(o: TranslatorOptions) {
    this.o = o;
  }

  translate(body: string, lang: string): Promise<string> {
    const argv = [...this.o.argv, instruction(lang)];
    // the command and the instruction are in the key: changing either must not serve old translations
    const key = createHash("sha256").update(JSON.stringify([argv, body])).digest("hex");
    const file = join(this.o.dir, `${key}.txt`);
    if (existsSync(file)) return Promise.resolve(readFileSync(file, "utf8"));
    let p = this.pending.get(key);
    if (!p) {
      p = this.slot(() => this.run(argv, body))
        .then((text) => {
          const part = `${file}.${process.pid}.part`;
          try {
            mkdirSync(this.o.dir, { recursive: true });
            writeFileSync(part, text);
            renameSync(part, file); // a reader never sees half a file
          } catch {
            rmSync(part, { force: true }); // the cache is best effort: a good translation is not lost over it
          }
          return text;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  close(): void {
    this.closed = true;
    for (const [c, settle] of [...this.children]) {
      killGroup(c, "SIGKILL"); // the process exits right after close(): no grace timer would ever fire
      settle(); // do not wait for stdio to close: a stubborn grandchild may hold it open
    }
    for (const wake of this.waiting.splice(0)) wake();
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (!this.closed && this.running >= this.o.max) await new Promise<void>((r) => this.waiting.push(r));
    if (this.closed) throw new Error("flows is shutting down");
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private run(argv: string[], body: string): Promise<string> {
    const [bin, ...args] = argv;
    const cwd = mkdtempSync(join(tmpdir(), "flows-translate-"));
    return new Promise((resolve, reject) => {
      let timedOut = false;
      // its own process group: a timeout or a shutdown ends what the translator started too
      const child = spawn(bin, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout!.on("data", (b: Buffer) => out.push(b));
      child.stderr!.on("data", (b: Buffer) => err.push(b));
      child.stdin!.on("error", () => {}); // a translator that exits before reading: its exit says why
      child.stdin!.end(body);
      const timer = setTimeout(() => { timedOut = true; stopGroup(child); end(null); }, this.o.timeoutMs);
      let ended = false;
      const end = (code: number | null, error?: Error) => {
        if (ended) return; // a spawn error may be followed by close
        ended = true;
        clearTimeout(timer);
        this.children.delete(child);
        rmSync(cwd, { recursive: true, force: true });
        const text = Buffer.concat(out).toString().trim();
        const tail = Buffer.concat(err).toString().trim().split("\n").slice(-5).join("\n");
        const limit = this.o.timeoutMs < 1000 ? `${this.o.timeoutMs} ms` : `${Math.round(this.o.timeoutMs / 1000)} s`;
        const fail = (why: string) => reject(new Error(tail ? `${why}:\n${tail}` : why));
        if (error) return fail(`the translator could not start (${error.message})`);
        if (timedOut) return fail(`the translator took longer than ${limit} and was stopped`);
        if (this.closed) return fail("flows is shutting down");
        if (code !== 0) return fail(`the translator failed (exit ${code})`);
        if (!text) return fail("the translator printed nothing");
        resolve(text);
      };
      this.children.set(child, () => end(null));
      child.on("error", (e) => end(null, e));
      child.on("close", (code) => end(code));
    });
  }
}

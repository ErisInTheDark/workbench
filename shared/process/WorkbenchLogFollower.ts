/*
 * Exports:
 * - default WorkbenchLogFollower: follow bounded recent process output across file rotation.
 */
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

type OpenLog = { file: FileHandle; offset: number; decoder: StringDecoder };

export default class WorkbenchLogFollower {
  private readonly prefixes: readonly string[];
  private started = false;
  private cancelScheduled: (() => void) | null = null;
  private readonly files = new Map<string, OpenLog>();
  private task: Promise<void> | null = null;
  private dirty = false;
  private closed = false;
  private initial = true;

  constructor(private readonly options: {
    directory: string;
    prefix: string | readonly string[];
    write(text: string): Promise<void>;
    failed(error: Error): void;
    schedule?: (callback: () => Promise<void>) => () => void;
  }) {
    this.prefixes = [...new Set(typeof options.prefix === "string" ? [options.prefix] : options.prefix)];
    if (!this.prefixes.length || this.prefixes.some(prefix => !/^[a-z-]+$/u.test(prefix))) throw new Error("Invalid process log prefix.");
  }

  async start() {
    if (this.started || this.closed) throw new Error("Log view has already started or closed.");
    this.started = true;
    await fs.mkdir(this.options.directory, { recursive: true });
    await this.refresh();
    this.scheduleNext();
  }

  private scheduleNext() {
    if (this.closed) return;
    // Directory notifications may not report writes to open files on Windows.
    // Schedule after draining so slow output never creates overlapping reads.
    const schedule = this.options.schedule ?? (callback => {
      const timer = setTimeout(() => { void callback(); }, 250);
      return () => clearTimeout(timer);
    });
    this.cancelScheduled = schedule(async () => {
      this.cancelScheduled = null;
      if (this.closed) return;
      try { await this.refresh(); }
      catch (error) {
        this.options.failed(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.scheduleNext();
    });
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    if (!this.task) {
      this.task = this.drain().finally(() => {
        this.task = null;
      });
    }
    return this.task;
  }

  private async drain() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const available = await fs.readdir(this.options.directory);
      const groups = this.prefixes.map(prefix => available
        .filter(file => file.startsWith(`${prefix}-`) && file.endsWith(".log")).sort().slice(-16));
      const names = groups.flat();
      const recentNames = new Set(groups.map(group => group.at(-1)));
      // Another rejected launch can write a newer diagnostic file while the
      // running owner keeps its older file. Follow retained files, not newest only.
      for (const [name, current] of this.files) {
        await this.read(current, false);
        if (!names.includes(name)) {
          const remaining = current.decoder.end();
          if (remaining) await this.options.write(remaining);
          await current.file.close();
          this.files.delete(name);
        }
      }
      for (const name of names) {
        if (this.closed) return;
        if (this.files.has(name)) continue;
        let file: FileHandle;
        try { file = await fs.open(path.join(this.options.directory, name), "r"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Rotation already pruned it.
          throw error;
        }
        const current = { file, offset: 0, decoder: new StringDecoder("utf8") };
        this.files.set(name, current);
        const size = (await file.stat()).size;
        const recent = this.initial && recentNames.has(name);
        current.offset = this.initial ? recent ? Math.max(0, size - 65_536) : size : 0;
        await this.read(current, recent);
      }
      if (names.length) this.initial = false;
    }
  }

  private async read(current: OpenLog, recent: boolean) {
    const size = (await current.file.stat()).size;
    if (size < current.offset) {
      current.offset = 0;
      current.decoder = new StringDecoder("utf8");
    }
    const buffer = Buffer.alloc(65_536);
    let first = true;
    while (!this.closed && current.offset < size) {
      const { bytesRead } = await current.file.read(buffer, 0, Math.min(buffer.length, size - current.offset), current.offset);
      if (!bytesRead) break;
      const wasMidFile = current.offset > 0;
      current.offset += bytesRead;
      let text = current.decoder.write(buffer.subarray(0, bytesRead));
      if (recent && first) {
        if (wasMidFile) text = text.slice(text.indexOf("\n") + 1);
        text = text.split("\n").slice(-101).join("\n");
      }
      first = false;
      if (text) await this.options.write(text);
    }
  }

  async close() {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    try { await this.task; }
    finally {
      const closing = [...this.files.values()].map(current => current.file.close());
      this.files.clear();
      const failures = (await Promise.allSettled(closing)).filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Log files could not be closed.");
    }
  }
}

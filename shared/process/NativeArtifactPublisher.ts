/*
 * Exports:
 * - NativeArtifactPublisherOptions: native platform validation and diagnostic boundary.
 * - NativeArtifactPublisher (default): validate and replace committed native artifacts safely.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface NativeArtifactPublisherOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  warn?: (message: string) => void;
}
export default class NativeArtifactPublisher {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly warn: (message: string) => void;

  constructor(options: NativeArtifactPublisherOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.warn = options.warn ?? console.warn;
  }

  async validate(file: string) {
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(64);
      const read = await handle.read(header, 0, header.length, 0);
      if (read.bytesRead < header.length) throw new Error(`Native executable is truncated: ${file}`);
      if (this.platform === "win32") {
        if (header.readUInt16LE(0) !== 0x5a4d) throw new Error(`Native executable is not a PE image: ${file}`);
        const pe = Buffer.alloc(6);
        const readPE = await handle.read(pe, 0, pe.length, header.readUInt32LE(0x3c));
        const machine = this.arch === "x64" ? 0x8664 : this.arch === "arm64" ? 0xaa64 : -1;
        if (readPE.bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== machine) {
          throw new Error(`Native executable has an invalid ${this.arch} PE header: ${file}`);
        }
      } else if (this.platform === "linux") {
        const machine = this.arch === "x64" ? 62 : this.arch === "arm64" ? 183 : -1;
        if (header.subarray(0, 4).toString("hex") !== "7f454c46" || header[4] !== 2 || header[5] !== 1
          || header.readUInt16LE(18) !== machine) {
          throw new Error(`Native executable has an invalid ${this.arch} ELF header: ${file}`);
        }
      } else {
        throw new Error(`Native publication does not support ${this.platform}/${this.arch}.`);
      }
    } finally {
      await handle.close();
    }
  }

  async publish(source: string, destination: string) {
    const directory = path.dirname(source);
    const name = path.basename(destination);
    const id = randomUUID();
    const candidate = path.join(directory, `${name}.publish-${id}`);
    const retired = path.join(directory, `${name}.retired-${id}`);
    await fs.copyFile(source, candidate);
    let previous = false;
    try {
      await this.validate(candidate);
      if (this.platform !== "win32") await fs.chmod(candidate, 0o755);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try { await fs.rename(destination, retired); previous = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.rename(candidate, destination);
    } catch (publicationError) {
      const failures = [publicationError];
      if (previous) {
        try { await fs.rename(retired, destination); }
        catch (error) { failures.push(error); }
      }
      try { await fs.unlink(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error); }
      if (failures.length > 1) throw new AggregateError(failures, "Native publication failed and recovery was incomplete.");
      throw publicationError;
    }
    // Existing running Windows images can remain locked until their owner exits.
    // Retain only those files; later developer builds retry their removal.
    for (const entry of await fs.readdir(directory)) {
      if (!entry.startsWith(`${name}.retired-`) || !/^[0-9a-f-]+$/u.test(entry.slice(`${name}.retired-`.length))) continue;
      try { await fs.unlink(path.join(directory, entry)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM") throw error;
        this.warn(`Retained running native image: ${path.join(directory, entry)}`);
      }
    }
    return await fs.stat(destination);
  }
}

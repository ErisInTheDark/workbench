/*
 * Exports:
 * - default WorkbenchRotatingLog: bounded synchronous process-log persistence with one active file.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export default class WorkbenchRotatingLog {
  private descriptor: number | null = null;
  private lines = 0;
  private sequence = 0;
  private closed = false;

  constructor(private readonly directory: string, private readonly prefix: string,
    private readonly maxLines = 1_000, private readonly maxFiles = 5) {
    if (!/^[a-z-]+$/u.test(prefix) || maxLines < 1 || maxFiles < 1) throw new Error("Invalid process log configuration.");
    mkdirSync(directory, { recursive: true });
  }

  write(value: string) {
    if (this.closed) throw new Error("Process log is closed.");
    for (const line of value.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      if (this.descriptor === null || this.lines >= this.maxLines) this.rotate();
      writeSync(this.descriptor!, line);
      if (line.endsWith("\n")) this.lines++;
    }
  }

  close() {
    this.closed = true;
    if (this.descriptor !== null) closeSync(this.descriptor);
    this.descriptor = null;
  }

  private rotate() {
    if (this.descriptor !== null) closeSync(this.descriptor);
    this.descriptor = null;
    const name = `${this.prefix}-${new Date().toISOString().replace(/[-:.]/gu, "")}-${process.pid}-${String(this.sequence++).padStart(6, "0")}.log`;
    this.descriptor = openSync(path.join(this.directory, name), "ax");
    this.lines = 0;
    const files = readdirSync(this.directory).filter(file => file.startsWith(`${this.prefix}-`) && file.endsWith(".log")).sort();
    for (const file of files.slice(0, -this.maxFiles)) {
      const target = path.join(this.directory, file);
      if (existsSync(target)) unlinkSync(target);
    }
  }
}

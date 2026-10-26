/*
 * Exports:
 * - default WorkbenchInstallationRecord: read, write and exclusively lock the data root's record of which checkout is installed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PHASES = ["cloning", "setup", "ready"];

export default class WorkbenchInstallationRecord {
  constructor({ dataRoot }) {
    this.path = path.join(dataRoot, "installation", "installation.json");
  }

  /** The record, or null when none exists; malformed records reject without being changed. */
  async read() {
    try {
      const record = JSON.parse(await fs.readFile(this.path, "utf8"));
      if (record.version !== 1 || typeof record.root !== "string" || !path.isAbsolute(record.root)
        || !PHASES.includes(record.phase)) {
        throw new Error(`Invalid Workbench installation record: ${this.path}. Existing files were not changed.`);
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(record) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const candidate = `${this.path}.${randomUUID()}.tmp`;
    await fs.writeFile(candidate, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(candidate, this.path);
  }

  /**
   * Holds the installation lock until `close()`. Closing the connection, or process death, releases the OS lock
   * without a stale PID or lock-file recovery path.
   */
  async lock() {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const lock = new DatabaseSync(`${this.path}.lock.sqlite3`);
    try {
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if (error.errcode === 5 || error.errcode === 6) {
        throw new Error("Another Workbench installation is running. Let it finish before trying again.");
      }
      throw error;
    }
    return { close: () => lock.close() };
  }
}

/*
 * Exports:
 * - default WorkbenchBusyLease: publish one process's busy reasons as a pid-stamped data-root lease, removed when it holds none.
 * - readWorkbenchBusyLeases: list the busy leases of live processes without installed dependencies.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOLDER_PATTERN = /^[a-z][a-z0-9-]*$/u;
const LEASE_PATTERN = /^([a-z][a-z0-9-]*)-(\d+)\.json$/u;
const MAX_REASON_LENGTH = 200;

const busyDirectory = dataRoot => path.join(dataRoot, "busy");

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

const bounded = error => (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f]/gu, " ").slice(0, 300);

export default class WorkbenchBusyLease {
  #reasons = new Map();
  #swept = false;

  constructor({ dataRoot, holder, pid = process.pid, alive = isAlive, warn = message => process.stderr.write(`${message}\n`) }) {
    if (!HOLDER_PATTERN.test(holder)) throw new Error(`Invalid busy lease holder: ${holder}`);
    this.directory = busyDirectory(dataRoot);
    this.filename = path.join(this.directory, `${holder}-${pid}.json`);
    this.holder = holder;
    this.pid = pid;
    this.alive = alive;
    this.warn = warn;
  }

  /** Set or replace one reason; null clears it. */
  hold(key, reason) {
    const next = reason === null ? null : reason.replace(/[\u0000-\u001f]/gu, " ").slice(0, MAX_REASON_LENGTH);
    if ((this.#reasons.get(key) ?? null) === next) return;
    if (next === null) this.#reasons.delete(key);
    else this.#reasons.set(key, next);
    this.#write();
  }

  /** Synchronous, so process exit handlers can release the lease. */
  close() {
    this.#reasons.clear();
    this.#write();
  }

  #write() {
    try {
      if (!this.#reasons.size) { fs.rmSync(this.filename, { force: true }); return; }
      fs.mkdirSync(this.directory, { recursive: true });
      this.#sweep();
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({
        holder: this.holder, pid: this.pid, reasons: [...this.#reasons.values()], updatedAt: Date.now(),
      }));
      fs.renameSync(temporary, this.filename);
    } catch (error) {
      this.warn(`Busy lease ${this.filename} could not be updated: ${bounded(error)}`);
    }
  }

  /** Crashed earlier processes of this holder leave leases and temporaries behind; their dead pids make readers ignore them. */
  #sweep() {
    if (this.#swept) return;
    this.#swept = true;
    for (const name of fs.readdirSync(this.directory)) {
      const match = /^([a-z][a-z0-9-]*)-(\d+)\.json(?:\.[0-9a-f-]+\.tmp)?$/u.exec(name);
      if (!match || match[1] !== this.holder) continue;
      const pid = Number(match[2]);
      if (pid !== this.pid && !this.alive(pid)) fs.rmSync(path.join(this.directory, name), { force: true });
    }
  }
}

/** A live process's unreadable lease still reads as busy, so callers fail closed. */
export async function readWorkbenchBusyLeases(dataRoot, { alive = isAlive } = {}) {
  let names;
  try { names = await fs.promises.readdir(busyDirectory(dataRoot)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const leases = [];
  for (const name of names.sort()) {
    const match = LEASE_PATTERN.exec(name);
    if (!match) continue;
    const holder = match[1];
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !alive(pid)) continue;
    let text;
    try { text = await fs.promises.readFile(path.join(busyDirectory(dataRoot), name), "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    const valid = value && value.holder === holder && value.pid === pid && Array.isArray(value.reasons)
      && value.reasons.every(reason => typeof reason === "string") && Number.isSafeInteger(value.updatedAt);
    leases.push(valid
      ? { holder, pid, reasons: value.reasons, updatedAt: value.updatedAt }
      : { holder, pid, reasons: ["unreadable busy lease"], updatedAt: null });
  }
  return leases;
}

/*
 * Keywords: linux, process group, retirement, procfs, signal.
 * Exports:
 * - LinuxProcessGroupRetirementOptions: OS observation and scheduling ports.
 * - default LinuxProcessGroupRetirement: own asynchronous Linux process-group retirement.
 */
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export interface LinuxProcessGroupRetirementOptions {
  listProcessIds?: () => Promise<number[]>;
  readProcessStat?: (pid: number) => Promise<string>;
  signalGroup?: (pid: number) => void;
  waitForNextCheck?: () => Promise<void>;
}

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function readGroupState(pid: number, stat: string) {
  // comm is parenthesized and may itself contain spaces, newlines, or parentheses.
  const end = stat.lastIndexOf(")");
  if (!stat.startsWith(`${pid} (`) || end < 0) throw new Error("Invalid Linux process stat.");
  const fields = stat.slice(end + 1).trim().split(/\s+/u);
  const state = fields[0];
  const group = Number(fields[2]);
  if (!state || !/^[A-Za-z]$/u.test(state) || !fields[2] || !/^\d+$/u.test(fields[2]) || !Number.isSafeInteger(group)) {
    throw new Error("Invalid Linux process stat.");
  }
  return { group, terminal: state === "Z" || state === "X" || state === "x" };
}

export default class LinuxProcessGroupRetirement {
  constructor(private readonly options: LinuxProcessGroupRetirementOptions = {}) {}

  async retire(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A valid owned Linux process group is required.");
    try {
      (this.options.signalGroup ?? ((group) => { process.kill(-group, "SIGTERM"); }))(pid);
    } catch (error) {
      if (hasCode(error, "ESRCH")) return;
      throw error;
    }
    while (await this.hasLiveMembers(pid)) {
      await (this.options.waitForNextCheck ?? (() => delay(100)))();
    }
  }

  private async hasLiveMembers(group: number) {
    const pids = this.options.listProcessIds
      ? await this.options.listProcessIds()
      : (await fs.readdir("/proc")).filter((name) => /^\d+$/u.test(name)).map(Number);
    for (const pid of pids) {
      let stat: string;
      try {
        stat = await (this.options.readProcessStat ?? ((id) => fs.readFile(`/proc/${id}/stat`, "utf8")))(pid);
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      const observed = readGroupState(pid, stat);
      if (observed.group === group && !observed.terminal) return true;
    }
    return false;
  }
}

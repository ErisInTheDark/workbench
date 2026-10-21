/*
 * Exports:
 * - RepairViewSnapshot/RepairViewControls: the dependency repair as `wb view` sees it, plus cancel, retry and idle waits.
 * - repairViewSnapshot: derive the view state from the journal and live lock owner.
 * - WorkbenchRepairViewControlsOptions: data, polling and process seams.
 * - default createWorkbenchRepairViewControls: poll repair activity using built-ins only, so it works while dependencies are missing.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  readRepairActivity, requestRepairCancel, type RepairActivity,
} from "../scripts/installation/update-repair.mjs";
import { isRepairPending } from "../scripts/installation/update-journal.mjs";

const POLL_MS = 500;

export interface RepairViewSnapshot {
  /** `running`: a process owns the repair lock. `pending`: dependencies need repair but nothing is repairing them. */
  state: "idle" | "running" | "pending";
  pid: number | null;
  lastError: string | null;
  logPath: string | null;
}

export interface RepairViewControls {
  snapshot(): RepairViewSnapshot;
  subscribe(listener: () => void): () => void;
  /** Ask the running repair to stop; it keeps its step and removes nothing. */
  cancel(): Promise<void>;
  /** Start the same repair as `wb repair` in the background. */
  retry(): Promise<void>;
  /** Resolves once no repair is pending. */
  whenIdle(signal: AbortSignal): Promise<void>;
  close(): void;
}

export interface WorkbenchRepairViewControlsOptions {
  dataRoot: string;
  repositoryRoot: string;
  read?: () => Promise<RepairActivity>;
  cancel?: (token: string) => Promise<void>;
  startRepair?: () => void;
  every?: (ms: number, tick: () => void) => () => void;
}

export function repairViewSnapshot(activity: RepairActivity): RepairViewSnapshot {
  const { journal, owner } = activity;
  return {
    state: owner ? "running" : isRepairPending(journal) ? "pending" : "idle",
    pid: owner?.pid ?? null,
    lastError: journal?.lastError ?? null,
    logPath: journal?.logPath ?? null,
  };
}

const same = (left: RepairViewSnapshot, right: RepairViewSnapshot) => left.state === right.state
  && left.pid === right.pid && left.lastError === right.lastError && left.logPath === right.logPath;

export default async function createWorkbenchRepairViewControls(
  options: WorkbenchRepairViewControlsOptions,
): Promise<RepairViewControls> {
  const read = options.read ?? (() => readRepairActivity(options.dataRoot));
  const listeners = new Set<() => void>();
  let activity: RepairActivity = { journal: null, owner: null };
  let current: RepairViewSnapshot = repairViewSnapshot(activity);
  let reading: Promise<void> | null = null;
  const refresh = () => reading ??= (async () => {
    try {
      activity = await read();
      const next = repairViewSnapshot(activity);
      if (same(current, next)) return;
      current = next;
    } catch (error) {
      // An unreadable journal still blocks dependencies; `wb repair` moves it aside, so retry stays available.
      const next: RepairViewSnapshot = { state: "pending", pid: null, logPath: null,
        lastError: error instanceof Error ? error.message : String(error) };
      if (same(current, next)) return;
      current = next;
    } finally { reading = null; }
    for (const listener of [...listeners]) listener();
  })();
  await refresh();
  const stop = (options.every ?? ((ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }))(POLL_MS, () => { void refresh(); });

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async cancel() {
      await refresh();
      const owner = activity.owner;
      if (!owner) throw new Error("No dependency repair is running.");
      await (options.cancel ?? (token => requestRepairCancel(options.dataRoot, token)))(owner.token);
    },
    async retry() {
      await refresh();
      if (current.state === "running") throw new Error("A dependency repair is already running.");
      (options.startRepair ?? (() => {
        // Detached and silent: the repair logs to its update log, which the view follows, and outlives the view.
        spawn(process.execPath, [path.join(options.repositoryRoot, "scripts", "installation", "update-repair.mjs")], {
          cwd: options.repositoryRoot, detached: true, stdio: "ignore", windowsHide: true,
        }).unref();
      }))();
    },
    whenIdle(signal) {
      return new Promise<void>((resolve, reject) => {
        const finish = () => { listeners.delete(check); signal.removeEventListener("abort", aborted); };
        const check = () => { if (current.state === "idle") { finish(); resolve(); } };
        const aborted = () => { finish(); reject(signal.reason); };
        if (signal.aborted) { reject(signal.reason); return; }
        listeners.add(check);
        signal.addEventListener("abort", aborted, { once: true });
        check();
      });
    },
    close() {
      stop();
      listeners.clear();
    },
  };
}

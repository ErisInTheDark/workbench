/*
 * Exports:
 * - RepairFiles/RepairOptions: injectable built-in repair boundaries.
 * - RepairActivity: the journal plus the live repair lock owner.
 * - prepareInstallationRuntime: make the managed PowerShell runtime ready without dependency repair.
 * - preparePulledInstallationRuntime: execute runtime preparation from the freshly pulled checkout.
 * - runRepair: resume repair without loading installed dependencies; cancellable while it owns the lock.
 * - readRepairActivity: read the journal and live lock owner for watchers.
 * - requestRepairCancel: ask one exact live repair owner to cancel.
 */
import type { InstallationRepairJournal } from "../../shared/workbench/installation-update.ts";
import type { JournalReadFiles } from "./update-journal.mjs";

export interface RepairFiles extends JournalReadFiles {
  mkdir(filename: string, options?: { recursive: true }): Promise<string | undefined | void>;
  writeFile(filename: string, text: string, options?: { mode: number; flag: string }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  readdir(filename: string): Promise<string[]>;
  unlink(filename: string): Promise<void>;
  rmdir(filename: string): Promise<void>;
  realpath(filename: string): Promise<string>;
  lstat(filename: string): Promise<{ isDirectory(): boolean }>;
  glob(pattern: string, options: { cwd: string; exclude: string[] }): AsyncIterable<string>;
  rm(filename: string, options: { recursive: true; force: true }): Promise<void>;
}
interface RepairCommandOptions {
  cwd: string;
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
  environment?: Record<string, string>;
}
export interface RepairOptions {
  root?: string;
  dataRoot?: string;
  force?: boolean;
  /** Cancels the repair; it keeps its rung and removes nothing. */
  signal?: AbortSignal;
  files?: Partial<RepairFiles>;
  now?: () => number;
  readJournal?: () => Promise<InstallationRepairJournal | null>;
  writeJournal?: (journal: InstallationRepairJournal) => Promise<void>;
  log?: (line: string) => Promise<void> | void;
  /** `host: false` leaves the host and daemon running. */
  stop?: (options: { host: boolean }) => Promise<void>;
  clean?: () => Promise<void>;
  /** Whether the daemon importers' installed dependencies differ from the lockfile. */
  daemonDependencyDrift?: () => Promise<boolean>;
  alive?: (pid: number) => boolean;
  terminate?: (pid: number) => Promise<void>;
  verify?: (endpoint: { pid: number }, name: string) => Promise<void>;
  quitApp?: (endpoint: { pid: number }) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  commands?: {
    run(command: string, args: string[], options: RepairCommandOptions): Promise<void>;
  };
  toolchain?: {
    ensure(options?: { onOutput?: (text: string) => void }): Promise<object | void>;
    run(args: string[], options: RepairCommandOptions): Promise<void>;
  };
  powerShell?: {
    ensure(options?: { onOutput?: (text: string) => void }): Promise<object | void>;
  };
}
export interface RepairActivity {
  journal: InstallationRepairJournal | null;
  owner: { pid: number; token: string } | null;
}
export function prepareInstallationRuntime(options?: RepairOptions): Promise<InstallationRepairJournal | null>;
export function preparePulledInstallationRuntime(root: string, options?: {
  signal?: AbortSignal;
  execute?: (command: string, args: string[], options: {
    cwd: string;
    windowsHide: boolean;
    signal?: AbortSignal;
  }) => Promise<unknown>;
}): Promise<void>;
export function runRepair(options?: RepairOptions): Promise<InstallationRepairJournal | null>;
export function readRepairActivity(
  dataRoot?: string,
  options?: { files?: Partial<RepairFiles>; alive?: (pid: number) => boolean },
): Promise<RepairActivity>;
export function requestRepairCancel(dataRoot: string, token: string, files?: Partial<RepairFiles>): Promise<void>;

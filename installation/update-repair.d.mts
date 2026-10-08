/*
 * Exports:
 * - RepairFiles/RepairOptions: injectable built-in repair boundaries.
 * - runRepair: resume repair without loading installed dependencies.
 */
import type { InstallationRepairJournal } from "../shared/workbench/installation-update.ts";
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
export interface RepairOptions {
  root?: string;
  dataRoot?: string;
  force?: boolean;
  files?: Partial<RepairFiles>;
  now?: () => number;
  readJournal?: () => Promise<InstallationRepairJournal | null>;
  writeJournal?: (journal: InstallationRepairJournal) => Promise<void>;
  log?: (line: string) => Promise<void> | void;
  stop?: () => Promise<void>;
  clean?: () => Promise<void>;
  alive?: (pid: number) => boolean;
  terminate?: (pid: number) => Promise<void>;
  verify?: (endpoint: { pid: number }, name: string) => Promise<void>;
  quitApp?: (endpoint: { pid: number }) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  commands?: {
    run(command: string, args: string[], options: { cwd: string; onOutput?: (text: string) => void }): Promise<void>;
  };
}
export function runRepair(options?: RepairOptions): Promise<InstallationRepairJournal | null>;

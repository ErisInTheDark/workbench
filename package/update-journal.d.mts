/*
 * Exports:
 * - JournalReadFiles/JournalWriteFiles: built-in filesystem seams for journal I/O.
 * - resolveDataRoot/journalPath: dependency-free user-data paths.
 * - readJournal/writeJournal/isRepairPending: typed durable journal boundary.
 */
import type { InstallationRepairJournal } from "../shared/workbench/installation-update.ts";
import type { WorkbenchDataRootOptions } from "../shared/workbench-data-root.ts";

export interface JournalReadFiles {
  readFile(filename: string, encoding: "utf8"): Promise<string>;
}
export interface JournalWriteFiles {
  mkdir(filename: string, options: { recursive: true }): Promise<string | undefined | void>;
  writeFile(filename: string, text: string, options: { mode: number; flag: string }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}
export function resolveDataRoot(options?: WorkbenchDataRootOptions): string;
export function journalPath(dataRoot?: string): string;
export function readJournal(dataRoot?: string, files?: JournalReadFiles): Promise<InstallationRepairJournal | null>;
export function writeJournal(journal: InstallationRepairJournal, dataRoot?: string, files?: JournalWriteFiles): Promise<void>;
export function isRepairPending(journal: InstallationRepairJournal | null): boolean;

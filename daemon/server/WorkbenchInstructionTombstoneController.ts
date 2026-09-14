/*
 * Exports:
 * - WorkbenchInstructionTombstoneDatabase: database port for durable tombstone receipts.
 * - default WorkbenchInstructionTombstoneController: consume retired instruction files once while preserving later user recreations.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  insertRow,
  selectRows,
  updateRows,
  type WorkbenchDatabaseMutation,
  type WorkbenchDatabaseQuery,
  type WorkbenchDatabaseRow,
} from "workbench-shared/database/workbench-database-statements";

import { instructionTombstoneTables } from "./lib/workbench/database/schema/instruction-tombstone-schema";
import type { WorkbenchInstructionTombstone } from "./lib/workbench/instructions/instruction-source";
import { workbenchLibraryRoot } from "./lib/workbench-library-paths";

export interface WorkbenchInstructionTombstoneDatabase {
  executeTransaction(statements: readonly WorkbenchDatabaseMutation[]): Promise<{ changes: number }>;
  query<Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Promise<Row[]>;
}

interface WorkbenchInstructionTombstoneControllerOptions {
  createReceiptId?: () => string;
  database: WorkbenchInstructionTombstoneDatabase;
  libraryRoot?: string;
  now?: () => number;
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export default class WorkbenchInstructionTombstoneController {
  readonly #createReceiptId: () => string;
  readonly #database: WorkbenchInstructionTombstoneDatabase;
  readonly #libraryRoot: string;
  readonly #now: () => number;

  constructor(options: WorkbenchInstructionTombstoneControllerOptions) {
    this.#createReceiptId = options.createReceiptId ?? randomUUID;
    this.#database = options.database;
    this.#libraryRoot = path.resolve(options.libraryRoot ?? workbenchLibraryRoot);
    this.#now = options.now ?? Date.now;
  }

  async consume(tombstones: readonly WorkbenchInstructionTombstone[]) {
    for (const tombstone of tombstones) await this.#consumeTarget(tombstone.targetRelativePath);
  }

  async #consumeTarget(targetRelativePath: string) {
    const [existing] = await this.#database.query(selectRows(
      instructionTombstoneTables.instructionTombstones,
      { where: { target_path: targetRelativePath } },
    ));
    if (existing) {
      await this.#finish(existing);
      return;
    }

    const quarantinePath = this.#quarantineRelativePath(targetRelativePath);
    if (await this.#kind(quarantinePath)) {
      throw new Error(`Instruction tombstone quarantine already exists: ${quarantinePath}`);
    }
    const now = this.#now();
    await this.#database.executeTransaction([insertRow(instructionTombstoneTables.instructionTombstones, {
      consumed_at: null,
      first_observed_at: now,
      quarantine_path: quarantinePath,
      state: "pending",
      target_path: targetRelativePath,
    })]);
    await this.#finish({
      consumed_at: null,
      first_observed_at: now,
      quarantine_path: quarantinePath,
      state: "pending",
      target_path: targetRelativePath,
    });
  }

  async #finish(row: {
    consumed_at: number | null;
    first_observed_at: number;
    quarantine_path: string;
    state: "pending" | "consumed";
    target_path: string;
  }) {
    const quarantineKind = await this.#kind(row.quarantine_path);
    if (row.state === "consumed") {
      if (quarantineKind) await this.#removeQuarantine(row.quarantine_path, quarantineKind);
      return;
    }

    if (!quarantineKind) {
      const targetKind = await this.#kind(row.target_path);
      if (targetKind) {
        this.#assertRemovableFile(row.target_path, targetKind);
        await fs.rename(this.#resolve(row.target_path), this.#resolve(row.quarantine_path));
      }
    } else {
      this.#assertRemovableFile(row.quarantine_path, quarantineKind);
    }

    await this.#database.executeTransaction([updateRows(
      instructionTombstoneTables.instructionTombstones,
      { consumed_at: this.#now(), state: "consumed" },
      { target_path: row.target_path, state: "pending" },
    )]);
    const movedKind = await this.#kind(row.quarantine_path);
    if (movedKind) await this.#removeQuarantine(row.quarantine_path, movedKind);
  }

  #quarantineRelativePath(targetRelativePath: string) {
    const normalized = targetRelativePath.replaceAll("\\", "/");
    const directory = path.posix.dirname(normalized);
    const filename = path.posix.basename(normalized, ".md");
    return path.posix.join(directory, `.${filename}.workbench-tombstone-${this.#createReceiptId()}`);
  }

  #resolve(relativePath: string) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      !normalized
      || normalized.startsWith("/")
      || /^[A-Za-z]:\//u.test(normalized)
      || path.posix.normalize(normalized) !== normalized
    ) {
      throw new Error(`Instruction tombstone path is invalid: ${relativePath}`);
    }
    const absolutePath = path.resolve(this.#libraryRoot, ...normalized.split("/"));
    if (absolutePath === this.#libraryRoot || !absolutePath.startsWith(`${this.#libraryRoot}${path.sep}`)) {
      throw new Error(`Instruction tombstone path is outside the Workbench Library: ${relativePath}`);
    }
    return absolutePath;
  }

  async #kind(relativePath: string) {
    try {
      const stats = await fs.lstat(this.#resolve(relativePath));
      if (stats.isFile()) return "file" as const;
      if (stats.isSymbolicLink()) return "symbolic-link" as const;
      return "other" as const;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  #assertRemovableFile(relativePath: string, kind: "file" | "symbolic-link" | "other") {
    if (kind === "other") throw new Error(`Instruction tombstone target is not a file: ${relativePath}`);
  }

  async #removeQuarantine(relativePath: string, kind: "file" | "symbolic-link" | "other") {
    this.#assertRemovableFile(relativePath, kind);
    await fs.unlink(this.#resolve(relativePath));
  }
}

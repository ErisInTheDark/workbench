/*
 * Exports:
 * - default GitArcProposalDiffRepository: own validated immutable proposal diff cache rows and atomic byte eviction.
 */
import type Database from "better-sqlite3";
import { z } from "zod";

import { GitCheckpointFileChangeSchema } from "workbench-shared/workbench/git/git-checkpoint-file-change";
import {
  compileWorkbenchDatabaseStatement,
  deleteRows,
  selectRows,
  updateRows,
  upsertRow,
} from "workbench-shared/database/workbench-database-statements";
import type { SelectRow } from "workbench-shared/database/schema/schema-definition";
import type {
  GitArcProposalDiffCacheIdentity,
  GitArcProposalDiffCacheValue,
} from "../../../lib/workbench/git/GitArcProposalDiffController";
import { gitArcProposalDiffTables, workbenchDatabaseTables } from "../workbench-database-schema.ts";

const ChangesSchema = z.array(GitCheckpointFileChangeSchema);
type CacheRow = SelectRow<typeof gitArcProposalDiffTables.gitArcProposalDiffs>;

function pathsEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export default class GitArcProposalDiffRepository {
  constructor(private readonly database: Database.Database, private readonly now: () => number = Date.now) {}

  read(identity: GitArcProposalDiffCacheIdentity) {
    const result = this.database.transaction(() => {
      const row = this.one(selectRows(gitArcProposalDiffTables.gitArcProposalDiffs, {
        where: { cache_key: identity.key },
      }));
      if (!row) return { kind: "miss" as const };
      try {
        const paths = z.array(z.string()).parse(JSON.parse(row.paths_json));
        if (
          row.repository_root !== identity.repositoryRoot
          || row.base_tree !== identity.baseTree
          || row.target_tree !== identity.targetTree
          || row.format_version !== identity.version
          || !pathsEqual(paths, identity.paths)
        ) {
          throw new Error("Cached proposal diff identity does not match its key.");
        }
        const changes = ChangesSchema.parse(JSON.parse(row.changes_json));
        this.run(updateRows(
          gitArcProposalDiffTables.gitArcProposalDiffs,
          { last_accessed_at: this.now() },
          { cache_key: identity.key },
        ));
        return { changes, kind: "hit" as const };
      } catch (error) {
        this.run(deleteRows(gitArcProposalDiffTables.gitArcProposalDiffs, { cache_key: identity.key }));
        return { error, kind: "corrupt" as const };
      }
    })();
    if (result.kind === "corrupt") throw result.error;
    return result.kind === "hit" ? result.changes : null;
  }

  write(value: GitArcProposalDiffCacheValue, maxBytes: number) {
    this.database.transaction(() => {
      const pathsJson = JSON.stringify(value.paths);
      const changesJson = JSON.stringify(value.changes);
      const byteSize = Buffer.byteLength(value.key)
        + Buffer.byteLength(value.repositoryRoot)
        + Buffer.byteLength(value.baseTree)
        + Buffer.byteLength(value.targetTree)
        + Buffer.byteLength(pathsJson)
        + Buffer.byteLength(changesJson)
        + 8;
      if (byteSize > maxBytes) {
        this.run(deleteRows(gitArcProposalDiffTables.gitArcProposalDiffs, { cache_key: value.key }));
        return;
      }
      this.run(upsertRow(gitArcProposalDiffTables.gitArcProposalDiffs, {
        base_tree: value.baseTree,
        byte_size: byteSize,
        cache_key: value.key,
        changes_json: changesJson,
        format_version: value.version,
        last_accessed_at: this.now(),
        paths_json: pathsJson,
        repository_root: value.repositoryRoot,
        target_tree: value.targetTree,
      }, {
        conflictColumns: ["cache_key"],
        updateColumns: [
          "repository_root", "base_tree", "target_tree", "paths_json", "changes_json",
          "byte_size", "last_accessed_at", "format_version",
        ],
      }));
      const rows = this.database.prepare(`
        SELECT cache_key, byte_size
        FROM workbench_git_arc_proposal_diffs
        ORDER BY last_accessed_at, cache_key
      `).all() as Array<Pick<CacheRow, "byte_size" | "cache_key">>;
      let totalBytes = rows.reduce((total, row) => total + row.byte_size, 0);
      for (const row of rows) {
        if (totalBytes <= maxBytes) break;
        this.run(deleteRows(gitArcProposalDiffTables.gitArcProposalDiffs, { cache_key: row.cache_key }));
        totalBytes -= row.byte_size;
      }
    })();
  }

  private one(statement: ReturnType<typeof selectRows<typeof gitArcProposalDiffTables.gitArcProposalDiffs>>) {
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
    return this.database.prepare(compiled.sql).get(...compiled.parameters) as CacheRow | undefined;
  }

  private run(statement: Parameters<typeof compileWorkbenchDatabaseStatement>[1]) {
    const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, statement);
    this.database.prepare(compiled.sql).run(...compiled.parameters);
  }
}

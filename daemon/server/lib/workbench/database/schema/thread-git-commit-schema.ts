/*
 * Exports:
 * - threadGitCommitTable: current permanent accepted-commit table definition.
 * - threadGitCommitSchemaHistory: permanent accepted-commit ownership schema history.
 */
import {
  addColumns, createTable, defineSubsystemHistory, defineTableHistory, sqlData, tableVersion,
} from "workbench-shared/database/schema/schema-history";
import {
  defineTable, integer, primaryKey, text, unique, type ColumnReferences,
} from "workbench-shared/database/schema/schema-definition";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";

const threadGitCommitColumns = {
  thread_id: text().notNull().references("workbench_thread_states", "thread_id", { onDelete: "CASCADE" }),
  root_id: text().notNull(),
  source_proposal_id: text().notNull(),
  history_index: integer().notNull().nonNegative(),
  commit_sha: text().notNull(),
  title: text().notNull(),
  description: text().notNull(),
};
const threadGitCommitConstraints = (table: ColumnReferences<typeof threadGitCommitColumns>) => ({
  constraints: [
    primaryKey([table.thread_id, table.root_id, table.source_proposal_id]),
    unique([table.thread_id, table.root_id, table.commit_sha]),
  ],
});

const threadGitCommitTableV1 = defineTable("workbench_thread_git_commits", threadGitCommitColumns, table => threadGitCommitConstraints(table));

export const threadGitCommitTable = defineTable("workbench_thread_git_commits", {
  ...threadGitCommitColumns,
  /** ISO commit time; null until recorded or backfilled from Git. */
  committed_at: text(),
}, table => threadGitCommitConstraints(table));

const commits = defineTableHistory({
  current: threadGitCommitTable,
  versions: [
    tableVersion({
      schemaVersion: databaseReleases.threadGitCommits.version,
      table: threadGitCommitTableV1,
      migration: createTable(threadGitCommitTableV1),
    }),
    tableVersion({
      schemaVersion: databaseReleases.threadGitCommitBackfill.version,
      table: threadGitCommitTableV1,
      migration: sqlData([`
        INSERT OR IGNORE INTO workbench_thread_git_commits (
          thread_id,
          root_id,
          source_proposal_id,
          history_index,
          commit_sha,
          title,
          description
        )
        SELECT
          observation.thread_id,
          proposal.root_id,
          proposal.proposal_id,
          proposal.proposal_index,
          proposal.summary_committed_sha,
          proposal.summary_title,
          proposal.summary_description
        FROM workbench_thread_git_observations observation
        JOIN workbench_thread_git_entries entry
          ON entry.observation_id = observation.id
        JOIN workbench_thread_git_proposals proposal
          ON proposal.entry_id = entry.id
        WHERE observation.observation_kind = 'arc'
          AND observation.has_value = 1
          AND entry.entry_kind = 'summary'
          AND proposal.status = 'committed'
          AND proposal.root_id IS NOT NULL
          AND proposal.summary_committed_sha IS NOT NULL
          AND proposal.summary_title IS NOT NULL
          AND proposal.summary_description IS NOT NULL
      `]),
    }),
    tableVersion({
      schemaVersion: databaseReleases.threadGitCommitTimes.version,
      table: threadGitCommitTable,
      migration: addColumns({ from: threadGitCommitTableV1, to: threadGitCommitTable, columns: ["committed_at"] }),
    }),
  ],
});

export const threadGitCommitSchemaHistory = defineSubsystemHistory([commits]);

/*
 * Exports:
 * - codexTranscriptTables: turn-owned provider pagination boundaries.
 * - codexTranscriptSchemaHistory: additive cursor-table release.
 */
import databaseReleases from "./releases.ts";
import { defineTable, text } from "../../../database/schema/schema-definition.ts";
import { createTable, defineSubsystemHistory, defineTableHistory, tableVersion } from "../../../database/schema/schema-history.ts";

const cursors = defineTable("codex_transcript_turn_cursors", {
  turn_id: text().primaryKey().references("thread_turns", "id", { onDelete: "CASCADE" }),
  previous_cursor: text(),
});
const history = defineTableHistory({
  current: cursors,
  versions: [tableVersion({
    schemaVersion: databaseReleases.codexTranscriptCursors.version,
    table: cursors,
    migration: createTable(cursors),
  })],
});

export const codexTranscriptTables = Object.freeze({ turnCursors: history.current });
export const codexTranscriptSchemaHistory = defineSubsystemHistory([history]);

/*
 * Exports:
 * - createSearchTestDatabase: in-memory current-schema database with foreign keys on.
 * - seedSearchThread: settle one thread (default or given project) with a user message and an agent message through the transcript owner.
 * - placeSearchThread: give a seeded thread top-level placement (archived or not) and optional settlement.
 */
import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

export function createSearchTestDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return database;
}

export function seedSearchThread(database: Database.Database, input: {
  activityAt?: number;
  assistantText: string;
  id: string;
  projectId?: fixtureIdentitySchemas.ProjectId;
  title: string;
  userText: string;
}) {
  const activityAt = input.activityAt ?? 1;
  const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(input.id);
  const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(`${input.id}-turn`);
  new WorkbenchTranscriptRepository(database).settle([{
    kind: "canonicalWindow",
    threadId,
    contentVersion: 3,
    materializedTurnIds: [turnId],
    observations: [
      {
        kind: "thread", threadId, projectId: input.projectId ?? testProjectIds.project,
        projectRoot: input.projectId ? `C:/${input.projectId}` : "C:/project",
        title: input.title, createdAt: activityAt, updatedAt: activityAt, activityAt,
      },
      {
        kind: "turn", threadId, turnId, turnIndex: 0, harnessId: "codex", nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(input.id),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(`${input.id}-turn`),
        state: "completed", createdAt: activityAt, startedAt: activityAt, endedAt: activityAt, durationMs: 0,
      },
      {
        kind: "item", threadId, turnId, lifecycle: "completed", observedAt: activityAt,
        item: { clientId: `${input.id}-user`, content: [{ text: input.userText, text_elements: [], type: "text" }], id: `${input.id}-user`, type: "userMessage" },
      },
      {
        kind: "item", threadId, turnId, lifecycle: "completed", observedAt: activityAt,
        item: { id: `${input.id}-assistant`, delivery: null, questions: null, memoryCitation: null, phase: "commentary", text: input.assistantText, type: "agentMessage" },
      },
    ],
  }]);
}

export function placeSearchThread(database: Database.Database, threadId: string, placement: { archived: boolean; settledAt?: number }) {
  database.prepare(`INSERT INTO workbench_thread_states (thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
    VALUES (?, 'topLevel', 'codex', 'thread', 1, 1)`).run(threadId);
  database.prepare("INSERT INTO workbench_top_level_thread_states (thread_id, thread_kind, archived) VALUES (?, 'topLevel', ?)")
    .run(threadId, Number(placement.archived));
  if (placement.settledAt !== undefined) {
    database.prepare("INSERT INTO workbench_thread_retention (thread_id, settled_at) VALUES (?, ?)").run(threadId, placement.settledAt);
  }
}

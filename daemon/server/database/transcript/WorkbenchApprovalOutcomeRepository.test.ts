/*
 * No production exports. Protect per-tool-item approval outcomes bound to stable item identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchApprovalOutcomeRepository from "./WorkbenchApprovalOutcomeRepository";
import WorkbenchTranscriptIdentityRepository from "./WorkbenchTranscriptIdentityRepository";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const nativeThreadId = fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread");
  const { threadId } = identities.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId },
    projectId: testProjectIds.project, projectRoot: "C:/project", title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1,
  });
  const turn = (native: string) => identities.observeTurn({
    kind: "turn", threadId, turnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(native),
    nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(native), nativeThreadId,
    nativeLocation: "C:/project", harnessId: "codex", state: "inProgress",
    createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
  }).turnId;
  const items = new WorkbenchTranscriptIdentityRepository(database);
  return { database, threadId, turn, items, outcomes: new WorkbenchApprovalOutcomeRepository(database) };
}

test("outcomes follow their item identity: one decision per item, turn-scoped reads, and identity reconciliation", () => {
  const { database, threadId, turn, items, outcomes } = fixture();
  try {
    const first = turn("first");
    const second = turn("second");
    const command = items.admit({ threadId, sources: [] }).itemId;
    const patch = items.admit({ threadId, sources: [] }).itemId;
    outcomes.record({ threadId, turnId: first, itemId: command, outcome: "denied", resolvedAt: 1 });
    outcomes.record({ threadId, turnId: first, itemId: command, outcome: "approved", resolvedAt: 2 });
    outcomes.record({ threadId, turnId: second, itemId: patch, outcome: "autoApproved", resolvedAt: 3 });
    assert.deepEqual(outcomes.read(threadId).map(({ itemId, outcome }) => [itemId, outcome]), [[command, "approved"], [patch, "autoApproved"]]);
    assert.deepEqual(outcomes.read(threadId, [second]).map(({ itemId }) => itemId), [patch]);
    assert.deepEqual(outcomes.read(threadId, []), []);

    // A provisional identity admitted for the approval later reconciles into the item's canonical identity.
    const canonical = items.admit({ threadId, sources: [] }).itemId;
    database.transaction(() => items.merge({ threadId, turnId: first, fromItemId: command, toItemId: canonical }))();
    assert.deepEqual(outcomes.read(threadId, [first]).map(({ itemId, outcome }) => [itemId, outcome]), [[canonical, "approved"]]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

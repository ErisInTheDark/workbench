/*
 * No exports. Protect relational facade replacement, rollback, draft moves and cold readback.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchThreadStateStore from "./WorkbenchThreadStateStore";
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";
import type { WorkbenchThreadDraft } from "workbench-shared/workbench/thread/thread-state";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayDraftKey } from "workbench-shared/workbench/thread/thread-display-layout";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { insertRow } from "workbench-shared/database/workbench-database-statements";
import { projectTables } from "./database/workbench-database-schema";

const fixtureIdentityValues = {
  DraftId: {
    "00000000-0000-4000-8000-000000000001": fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  },
  ProjectId: {
    "first": testProjectIds.first,
    "second": testProjectIds.second,
  },
};

test("consumer objects retain thread facts, title replacement and project isolation across cold reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-relational-facade-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const database = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  try {
    const identities = await database.observeThreadIdentities((["first", "second"] as const).map(projectId => ({
      native: { harness: "codex" as const, nativeLocation: join(directory, projectId), nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(projectId) },
      projectId: fixtureIdentityValues.ProjectId[projectId], projectRoot: join(directory, projectId), title: projectId, createdAt: 1, updatedAt: 1, activityAt: 1,
    })));
    const store = new WorkbenchThreadStateStore(database);
    const records = identities.map((identity): WorkbenchThreadStateRecord => ({
      entryKind: "thread", identity: { harness: "codex", threadId: identity.threadId }, title: identity.projectId,
      activityAt: 1, metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "completed", reason: "userCompleted", settled: false },
      gitHistoryCleanedAt: null, mcpGeneration: null, profile: null, providerObserved: true, settledAt: null, snoozedUntil: null,
    }));
    for (const [index, record] of records.entries()) {
      await store.writeProject(identities[index]!.projectId, { version: 4, records: [record], drafts: [] },
        [{ identity: record.identity, titles: [{ title: "old", usedAt: 1 }] }]);
    }
    const first = records[0]!;
    const updated = [{ identity: first.identity, titles: [{ title: "renamed", usedAt: 3 }] }];
    await store.writeChanges(fixtureIdentityValues.ProjectId["first"], { records: [{ ...first, title: "renamed", titleHistory: updated[0]!.titles }] });
    const before = await store.readProject(fixtureIdentityValues.ProjectId["first"]);
    await assert.rejects(store.writeProject(fixtureIdentityValues.ProjectId["first"], { version: 4, records: [records[1]], drafts: [] }), /project/i);
    assert.deepEqual(await store.readProject(fixtureIdentityValues.ProjectId["first"]), before);
    assert.deepEqual(await store.readTitleHistories(fixtureIdentityValues.ProjectId["first"]), updated);
    assert.deepEqual(await store.readTitleHistories(fixtureIdentityValues.ProjectId["second"]), [{ identity: records[1]!.identity, titles: [{ title: "old", usedAt: 1 }] }]);
    await assert.rejects(store.writeChanges(fixtureIdentityValues.ProjectId["first"], {
      records: [{ ...first, title: "must roll back" }, records[1]!],
    }), /project/i);
    assert.deepEqual(await store.readProject(fixtureIdentityValues.ProjectId["first"]), before);
    await database.close();
    reopened = new WorkbenchDatabaseController({ databasePath });
    const cold = new WorkbenchThreadStateStore(reopened);
    assert.deepEqual(await cold.readProject(fixtureIdentityValues.ProjectId["first"]), before);
    assert.deepEqual(await cold.readTitleHistories(fixtureIdentityValues.ProjectId["first"]), updated);
    await cold.writeChanges(fixtureIdentityValues.ProjectId["first"], { records: [{ ...first, title: "renamed" }] });
    assert.deepEqual(await cold.readTitleHistories(fixtureIdentityValues.ProjectId["first"]), updated);
    await cold.writeChanges(fixtureIdentityValues.ProjectId["first"], { records: [{ ...first, title: "renamed", titleHistory: [] }] });
    assert.deepEqual(await cold.readTitleHistories(fixtureIdentityValues.ProjectId["first"]), []);
  } finally {
    await reopened?.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("project-qualified draft replacement preserves a moved draft and removes deleted layout references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-draft-facade-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await database.executeTransaction([
      insertRow(projectTables.projects, { id: fixtureIdentityValues.ProjectId.first }),
      insertRow(projectTables.projects, { id: fixtureIdentityValues.ProjectId.second }),
    ]);
    const store = new WorkbenchThreadStateStore(database);
    const draft: WorkbenchThreadDraft = {
      draftId: fixtureIdentityValues.DraftId["00000000-0000-4000-8000-000000000001"], projectId: fixtureIdentityValues.ProjectId["first"],
      attachments: [{ id: "attachment", url: "data:text/plain,kept" }],
      composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null },
      profileId: null, prompt: "kept", clientUpdatedAt: 2, createdAt: 1, updatedAt: 2,
    };
    const document = (drafts: WorkbenchThreadDraft[]) => ({ version: 4, records: [], drafts: drafts.map(value => ({ ...value, pinned: true, snoozed: false })) });
    await store.writeProject(fixtureIdentityValues.ProjectId["first"], document([draft]));
    await store.writeProject(fixtureIdentityValues.ProjectId["second"], document([{ ...draft, projectId: fixtureIdentityValues.ProjectId["second"] }]));
    await store.writeChanges(fixtureIdentityValues.ProjectId["first"], { deletedDraftIds: [draft.draftId] });
    await store.writeProject(fixtureIdentityValues.ProjectId["first"], document([]));
    assert.equal((await store.readProject(fixtureIdentityValues.ProjectId["second"])).drafts[0]?.prompt, "kept");
    const key = getProjectQualifiedThreadDisplayKey(fixtureIdentityValues.ProjectId["second"], getThreadDisplayDraftKey(draft.draftId));
    await store.writeGlobal("pinnedLayout", {
      version: 1, revision: 2, importedProjectIds: [fixtureIdentityValues.ProjectId.second],
      displayOrder: { pinned: { [key]: { above: [], below: [] } } },
    });
    await store.writeChanges(fixtureIdentityValues.ProjectId["second"], { deletedDraftIds: [draft.draftId] });
    const pinned = await store.readGlobal("pinnedLayout") as { displayOrder: { pinned?: object } };
    assert.deepEqual(pinned.displayOrder.pinned ?? {}, {});
    assert.deepEqual((await store.readProject(fixtureIdentityValues.ProjectId["second"])).drafts, []);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

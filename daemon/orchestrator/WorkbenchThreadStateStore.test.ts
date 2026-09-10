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
import { getProjectQualifiedThreadDisplayKey } from "workbench-shared/workbench/thread/thread-display-layout";

test("consumer objects retain thread facts, title replacement and project isolation across cold reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-relational-facade-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const database = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  try {
    const identities = await database.observeThreadIdentities(["first", "second"].map(projectId => ({
      native: { harness: "codex" as const, nativeLocation: join(directory, projectId), nativeThreadId: projectId },
      projectId, projectRoot: join(directory, projectId), title: projectId, createdAt: 1, updatedAt: 1, activityAt: 1,
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
    await store.writeProject("first", { version: 4, records: [{ ...first, title: "renamed" }], drafts: [] }, updated);
    const before = await store.readProject("first");
    await assert.rejects(store.writeProject("first", { version: 4, records: [records[1]], drafts: [] }), /project/i);
    assert.deepEqual(await store.readProject("first"), before);
    assert.deepEqual(await store.readTitleHistories("first"), updated);
    assert.deepEqual(await store.readTitleHistories("second"), [{ identity: records[1]!.identity, titles: [{ title: "old", usedAt: 1 }] }]);
    await database.close();
    reopened = new WorkbenchDatabaseController({ databasePath });
    const cold = new WorkbenchThreadStateStore(reopened);
    assert.deepEqual(await cold.readProject("first"), before);
    assert.deepEqual(await cold.readTitleHistories("first"), updated);
    await cold.writeProject("first", before, []);
    assert.deepEqual(await cold.readTitleHistories("first"), []);
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
    const store = new WorkbenchThreadStateStore(database);
    const draft: WorkbenchThreadDraft = {
      draftId: "00000000-0000-4000-8000-000000000001", projectId: "first",
      attachments: [{ id: "attachment", url: "data:text/plain,kept" }],
      composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null },
      profileId: null, prompt: "kept", clientUpdatedAt: 2, createdAt: 1, updatedAt: 2,
    };
    const document = (drafts: WorkbenchThreadDraft[]) => ({ version: 4, records: [], drafts: drafts.map(value => ({ ...value, pinned: true, snoozed: false })) });
    await store.writeProject("first", document([draft]));
    await store.writeProject("second", document([{ ...draft, projectId: "second" }]));
    await store.writeProject("first", document([]));
    assert.equal((await store.readProject("second")).drafts[0]?.prompt, "kept");
    const key = getProjectQualifiedThreadDisplayKey("second", `draft:${draft.draftId}`);
    await store.writeGlobal("pinnedLayout", {
      version: 1, revision: 2, importedProjectIds: ["second"],
      displayOrder: { pinned: { [key]: { above: [], below: [] } } },
    });
    await store.writeProject("second", document([]));
    const pinned = await store.readGlobal("pinnedLayout") as { displayOrder: { pinned?: object } };
    assert.deepEqual(pinned.displayOrder.pinned ?? {}, {});
    assert.deepEqual((await store.readProject("second")).drafts, []);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

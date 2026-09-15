/* No exports. Protect provider translation, admitted references and preserved opaque content. */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "./database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import CodexProviderObservations, { admitCodexTranscriptObservations } from "./CodexProviderObservations";
import { NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

test("one provider ingress publishes admitted references without rewriting content or native recovery input", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: async input => repository.observeMany(input),
    resolveThreadIdentity: async input => repository.resolve(input),
    resolveNativeThreadIdentity: async input => repository.resolveNative(input),
    observeTurnIdentities: async input => repository.observeTurns(input),
    resolveTurnIdentity: async input => repository.resolveTurn(input),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async input => itemRepository.admitMany(input),
    resolveTranscriptItemIdentity: async input => itemRepository.resolve(input),
  });
  try {
    await threads.start();
    const native = { harness: "codex", nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native-thread") };
    const thread = await threads.observe({
      native, projectId: ProjectIdSchema.parse("local:///repo"), projectRoot: "/repo",
      title: "Thread", createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    const nativeTurnId = NativeTurnIdSchema.parse("native-turn");
    const item: ThreadItem = { type: "reasoning", id: "item-12", summary: ["native-thread is content"], content: ["native-turn"] };
    const owners = { threads, items };
    await admitCodexTranscriptObservations(owners, [{
      kind: "turn", threadId: native.nativeThreadId, turnId: nativeTurnId, nativeTurnId,
      harnessId: "codex", nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
      state: "inProgress", createdAt: 1, startedAt: 1, endedAt: null, durationMs: null,
    }, {
      kind: "item", threadId: native.nativeThreadId, turnId: nativeTurnId, item, lifecycle: "streaming", observedAt: 1,
    }]);
    const turnId = threads.workbenchTurnIdForNative({ ...native, nativeTurnId });
    const itemId = items.itemIdForSource(thread.threadId, { turnId, sourceId: item.id, kind: "provisional" });
    const edge = new CodexProviderObservations(owners);
    const nativeEvent = { method: "item/started", params: { threadId: native.nativeThreadId, turnId: nativeTurnId, item, startedAtMs: 1 } };
    const publication = edge.native(nativeEvent);
    assert.equal(publication.nativeNotification, nativeEvent);
    assert.deepEqual(publication.notification.params, {
      ...nativeEvent.params, threadId: thread.threadId, turnId,
      item: { ...item, id: itemId, workbenchIdentityKind: "provisional" },
    });
    assert.deepEqual(publication.observation.activity, { kind: "activity", threadId: thread.threadId });
    assert.equal(publication.observation.projectId, thread.projectId);
    const delta = edge.native({
      method: "item/reasoning/textDelta",
      params: { threadId: native.nativeThreadId, turnId: nativeTurnId, itemId: item.id, contentIndex: 0, delta: "item-12" },
    });
    assert.deepEqual(delta.notification.params, { threadId: thread.threadId, turnId, itemId, contentIndex: 0, delta: "item-12" });
    assert.equal(delta.observation.activity, null);
    assert.equal(delta.observation.lifecycle, null);
    const title = edge.native({ method: "thread/name/updated", params: { threadId: native.nativeThreadId, threadName: "Renamed" } });
    assert.deepEqual(title.observation.title, { threadId: thread.threadId, title: "Renamed" });
    const pending = edge.workbench({
      method: "turn/started", params: { threadId: thread.threadId, turn: {
        id: "not-admitted", workbenchAdmission: "connecting", items: [{ type: "userMessage" }],
      } },
    });
    assert.equal(pending.lifecycle, null);
  } finally {
    items.dispose();
    threads.dispose();
    database.close();
  }
});

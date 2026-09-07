/*
 * Keywords: identity, live delta, structural admission, reload, failure, disposal.
 * No exports. Tests protect publication after committed identity and synchronous delta lookup without body reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WorkbenchTranscriptIdentityDatabase,
  WorkbenchTranscriptItemIdentity,
} from "./database/transcript/workbench-transcript-types";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";

const identity: WorkbenchTranscriptItemIdentity = {
  threadId: "thread", itemId: "997ac72d-b3a2-4bdb-b887-9fdd306767b3",
  sources: [{ turnId: "turn", kind: "stable", sourceId: "native-source" }],
  legacyAliases: [],
};

test("structural admission enables every delta without another database lookup", async () => {
  let admissions = 0;
  const database: WorkbenchTranscriptIdentityDatabase = {
    admitTranscriptItemIdentities: async () => {
      admissions += 1;
      return [identity];
    },
    resolveTranscriptItemIdentity: async () => { throw new Error("Unexpected live database lookup"); },
  };
  const controller = new WorkbenchTranscriptIdentityController(database);
  assert.throws(() => controller.itemIdForSource(identity.threadId, identity.sources[0]!), /not been admitted/iu);
  await controller.admit([identity]);
  for (let delta = 0; delta < 20; delta += 1) {
    assert.equal(controller.itemIdForSource(identity.threadId, identity.sources[0]!), identity.itemId);
  }
  assert.equal(admissions, 1);
  assert.throws(() => controller.itemIdForSource("another-thread", identity.sources[0]!), /not been admitted/iu);
  assert.throws(() => controller.itemIdForSource(identity.threadId, { ...identity.sources[0]!, turnId: "another-turn" }), /not been admitted/iu);
  controller.dispose();
  assert.throws(() => controller.itemIdForSource(identity.threadId, identity.sources[0]!), /disposed/iu);
});

test("failed or late identity admission cannot become a live mapping", async () => {
  let resolve!: (identities: WorkbenchTranscriptItemIdentity[]) => void;
  const late = new Promise<WorkbenchTranscriptItemIdentity[]>((complete) => { resolve = complete; });
  const controller = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: () => late,
    resolveTranscriptItemIdentity: async () => null,
  });
  const pending = controller.admit([identity]);
  controller.dispose();
  resolve([identity]);
  await assert.rejects(pending, /disposed/iu);
  const failed = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async () => { throw new Error("identity write failed"); },
    resolveTranscriptItemIdentity: async () => null,
  });
  await assert.rejects(failed.admit([identity]), /identity write failed/iu);
  assert.throws(() => failed.itemIdForSource(identity.threadId, identity.sources[0]!), /not been admitted/iu);
  failed.dispose();
});

test("refreshed aliases redirect cached public references to the surviving item without database reads", async () => {
  const survivor: WorkbenchTranscriptItemIdentity = {
    ...identity, itemId: "35e4cbed-9ef3-4b78-b7d0-e5533240999e",
    legacyAliases: [
      { turnId: "turn", alias: identity.itemId },
      { turnId: "turn", alias: "legacy-item" },
    ],
  };
  let calls = 0;
  const controller = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async () => [identity],
    resolveTranscriptItemIdentity: async () => { calls += 1; return survivor; },
  });
  await controller.admit([identity]);
  assert.equal(controller.itemIdForReference("thread", "turn", identity.itemId), identity.itemId);
  await controller.resolve({ threadId: "thread", turnId: "turn", itemId: identity.itemId });
  for (const reference of [identity.itemId, survivor.itemId, "native-source", "legacy-item"]) {
    assert.equal(controller.itemIdForReference("thread", "turn", reference), survivor.itemId);
  }
  assert.equal(calls, 1);
  assert.throws(() => controller.itemIdForReference("thread", "other-turn", "legacy-item"), /not been admitted/iu);
  assert.throws(() => controller.itemIdForReference("other-thread", "turn", survivor.itemId), /not been admitted/iu);
  controller.dispose();
});

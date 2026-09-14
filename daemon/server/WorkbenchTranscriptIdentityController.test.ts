/*
 * No exports. Tests protect publication after committed identity and synchronous delta lookup without body reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WorkbenchTranscriptIdentityDatabase,
  WorkbenchTranscriptItemIdentity,
} from "./database/transcript/workbench-transcript-types";
import WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  WorkbenchItemId: {
    "35e4cbed-9ef3-4b78-b7d0-e5533240999e": fixtureIdentitySchemas.WorkbenchItemIdSchema.parse("35e4cbed-9ef3-4b78-b7d0-e5533240999e"),
    "997ac72d-b3a2-4bdb-b887-9fdd306767b3": fixtureIdentitySchemas.WorkbenchItemIdSchema.parse("997ac72d-b3a2-4bdb-b887-9fdd306767b3"),
  },
  WorkbenchThreadId: {
    "another-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("another-thread"),
    "other-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("other-thread"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  },
  WorkbenchTurnId: {
    "another-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("another-turn"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

const identity: WorkbenchTranscriptItemIdentity = {
  threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], itemId: fixtureIdentityValues.WorkbenchItemId["997ac72d-b3a2-4bdb-b887-9fdd306767b3"],
  sources: [{ turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], kind: "stable", sourceId: "native-source" }],
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
  assert.throws(() => controller.itemIdForSource(fixtureIdentityValues.WorkbenchThreadId["another-thread"], identity.sources[0]!), /not been admitted/iu);
  assert.throws(() => controller.itemIdForSource(identity.threadId, { ...identity.sources[0]!, turnId: fixtureIdentityValues.WorkbenchTurnId["another-turn"] }), /not been admitted/iu);
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
    ...identity, itemId: fixtureIdentityValues.WorkbenchItemId["35e4cbed-9ef3-4b78-b7d0-e5533240999e"],
    legacyAliases: [
      { turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], alias: identity.itemId },
      { turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], alias: "legacy-item" },
    ],
  };
  let calls = 0;
  const controller = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: async () => [identity],
    resolveTranscriptItemIdentity: async () => { calls += 1; return survivor; },
  });
  await controller.admit([identity]);
  assert.equal(controller.itemIdForReference(fixtureIdentityValues.WorkbenchThreadId["thread"], fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), identity.itemId), identity.itemId);
  await controller.resolve({ threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], itemId: identity.itemId });
  for (const reference of [identity.itemId, survivor.itemId, "native-source", "legacy-item"]) {
    assert.equal(controller.itemIdForReference(fixtureIdentityValues.WorkbenchThreadId["thread"], fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), fixtureIdentitySchemas.ItemReferenceSchema.parse(reference)), survivor.itemId);
  }
  assert.equal(calls, 1);
  assert.throws(() => controller.itemIdForReference(fixtureIdentityValues.WorkbenchThreadId["thread"], fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("other-turn"), fixtureIdentitySchemas.ItemReferenceSchema.parse("legacy-item")), /not been admitted/iu);
  assert.throws(() => controller.itemIdForReference(fixtureIdentityValues.WorkbenchThreadId["other-thread"], fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"), survivor.itemId), /not been admitted/iu);
  controller.dispose();
});

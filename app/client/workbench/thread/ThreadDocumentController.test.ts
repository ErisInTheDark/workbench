/*
 * Exports:
 * - No production exports; Node tests protect per-thread source, projection, revision, and streaming ownership.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadPayload } from "workbench-shared/types";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import ThreadDocumentStore from "../state/ThreadDocumentStore.ts";
import ThreadDocumentController from "./ThreadDocumentController.ts";

type ProviderThreadPayload = Extract<ThreadPayload, { isDraft: false }>;

function thread(overrides: Partial<ProviderThreadPayload> = {}): ProviderThreadPayload {
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/repo",
    harness: "codex",
    id: WorkbenchThreadIdSchema.parse("thread"),
    isDraft: false,
    model: "model",
    name: null,
    path: null,
    preview: "",
    reasoningEffort: null,
    serviceTier: null,
    source: "codex",
    status: "idle",
    tokenUsage: null,
    turnHistory: [],
    turns: [],
    updatedAt: 1,
    ...overrides,
  };
}

function createController() {
  const documents = ThreadDocumentStore();
  let browseResultEntries: ThreadPayload["browseResultEntries"] = [];
  const controller = new ThreadDocumentController({
    applyBrowseResultOverlay: source => ({ ...source, browseResultEntries }),
    applyOptimisticOverlay: source => source,
    applyQuestionnaireOverlay: source => source,
    applySteerOverlay: source => source,
    documents,
    key: "codex:thread",
    normalizeCanonicalThread: source => source,
  });
  return {
    controller,
    documents,
    setBrowseResultEntries(entries: ThreadPayload["browseResultEntries"]) {
      browseResultEntries = entries;
      controller.bumpOverlay("browseResultRevision");
    },
  };
}

test("one owner publishes canonical, stable preference, status, and visible projection state", () => {
  const { controller, documents } = createController();
  controller.installSource(thread({ model: "stable-model", status: "idle" }));
  controller.captureStablePreferences(controller.getSource()!);
  controller.installSource(thread({ model: null, status: "idle", updatedAt: 2 }));
  controller.setStatus("active");

  const visible = controller.materialize({ select: true });

  assert.equal(visible?.model, "stable-model");
  assert.equal(visible?.status, "active");
  assert.equal(documents.getSelectedDocument(), visible);
  assert.deepEqual(controller.getSnapshot().revision, {
    browseResultRevision: 0,
    optimisticRevision: 0,
    questionnaireForceProjectionEpoch: 0,
    questionnaireRevision: 0,
    sourceRevision: 2,
    stablePreferenceRevision: 1,
    statusRevision: 1,
    steerRevision: 0,
  });
});

test("overlay revisions invalidate only their thread's visible projection", () => {
  const first = createController();
  const secondDocuments = ThreadDocumentStore();
  const second = new ThreadDocumentController({
    applyBrowseResultOverlay: source => source,
    applyOptimisticOverlay: source => source,
    applyQuestionnaireOverlay: source => source,
    applySteerOverlay: source => source,
    documents: secondDocuments,
    key: "codex:other",
    normalizeCanonicalThread: source => source,
  });
  first.controller.installSource(thread());
  second.installSource(thread({ id: WorkbenchThreadIdSchema.parse("other") }));
  const secondRevision = second.getRevision();

  first.setBrowseResultEntries([{
    action: "open",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: null,
    detailKind: "result",
    detailText: "result",
    durationMs: 1,
    entryKey: "entry",
    recordedAt: 1,
    session: "session",
    state: "completed",
    threadId: "thread",
    turnId: "turn",
  }]);
  const visible = first.controller.materialize();

  assert.equal(visible?.browseResultEntries?.[0]?.detailText, "result");
  assert.equal(first.controller.getRevision().browseResultRevision, 1);
  assert.deepEqual(second.getRevision(), secondRevision);
});

test("revision evidence rejects late work after source or overlay changes", () => {
  const { controller } = createController();
  controller.installSource(thread());
  const sourceFence = controller.getRevision();
  controller.updateSource(source => ({ ...source, updatedAt: 2 }));
  assert.equal(controller.isRevisionCurrent(sourceFence), false);

  const overlayFence = controller.getRevision();
  controller.bumpOverlay("questionnaireRevision");
  assert.equal(controller.isRevisionCurrent(overlayFence), false);
});

test("streaming provenance is isolated per thread owner", () => {
  const first = createController().controller;
  const second = createController().controller;
  first.streaming.addClientCreatedItemKey("turn:item");

  assert.equal(first.streaming.hasClientCreatedItemKey("turn:item"), true);
  assert.equal(second.streaming.hasClientCreatedItemKey("turn:item"), false);
});

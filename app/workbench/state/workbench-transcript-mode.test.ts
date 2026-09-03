/*
 * No production exports. Tests protect the browser-global transcript mode default, rotation order, normalisation, and app-state persistence intent. Keywords: transcript, mode, rotator, app state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";

import WorkbenchClientStateController from "./WorkbenchClientStateController";
import {
  canPersistWorkbenchTranscriptMode,
  getNextWorkbenchTranscriptMode,
  readWorkbenchTranscriptMode,
  resolveWorkbenchTranscriptMode,
  writeWorkbenchTranscriptMode,
} from "./workbench-transcript-mode";

test("transcript mode defaults to JSON and rotates through comparison and SQLite", () => {
  assert.equal(readWorkbenchTranscriptMode(), "json");
  assert.equal(getNextWorkbenchTranscriptMode("json"), "compare");
  assert.equal(getNextWorkbenchTranscriptMode("compare"), "sqlite");
  assert.equal(getNextWorkbenchTranscriptMode("sqlite"), "json");
});

test("mobile transcript mode rotates only JSON and SQLite without overwriting a desktop comparison choice", () => {
  assert.equal(resolveWorkbenchTranscriptMode("compare", { includeComparison: false }), "sqlite");
  assert.equal(getNextWorkbenchTranscriptMode("json", { includeComparison: false }), "sqlite");
  assert.equal(getNextWorkbenchTranscriptMode("compare", { includeComparison: false }), "json");
  assert.equal(getNextWorkbenchTranscriptMode("sqlite", { includeComparison: false }), "json");
});

test("transcript mode waits for the additive app-state schema capability", () => {
  assert.equal(canPersistWorkbenchTranscriptMode(5), false);
  assert.equal(canPersistWorkbenchTranscriptMode(6), true);
  assert.equal(canPersistWorkbenchTranscriptMode(7), true);
});

test("transcript mode normalises invalid stored values", () => {
  const records = [{
    kind: "globalPreference",
    preference: {
      key: "transcriptProjectionMode",
      value: "future-mode",
    },
  }] as unknown as WorkbenchClientStateRecord[];
  assert.equal(readWorkbenchTranscriptMode(records), "json");
});

test("transcript mode writes through the app-state controller", async () => {
  const controller = new WorkbenchClientStateController();
  await writeWorkbenchTranscriptMode(controller, "sqlite");
  assert.equal(readWorkbenchTranscriptMode(controller.getSnapshot().records), "sqlite");
});

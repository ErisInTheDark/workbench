/*
 * No production exports. Tests protect shared operation dispatch and database-derived transcript compatibility. Keywords: transcript, protocol, conformance.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  conformWorkbenchTranscriptSnapshot,
  decodeWorkbenchTranscriptRequest,
  transcriptSnapshotTables,
  workbenchTranscriptOperations,
} from "./workbench-transcript-contract.ts";

const thread = {
  id: "thread",
  project_id: "project",
  project_root: "C:/project",
  title: "Thread",
  archived: 0,
  pinned: 0,
  snoozed: 0,
  transcript_content_version: 1,
  next_turn_index: 0,
  created_at: 1,
  updated_at: 1,
  activity_at: 1,
};

test("read and subscription decoding retain supported protocol versions and reject unsupported ones", () => {
  for (const method of [workbenchTranscriptOperations.read.method, workbenchTranscriptOperations.subscribe.method]) {
    const input = { threadId: "thread", turnLimit: 1, subscriptionId: "sub", protocolVersion: 2 };
    const decoded = decodeWorkbenchTranscriptRequest(method, input);
    assert.ok(decoded?.success);
    assert.equal((decoded.data.params as { protocolVersion?: number }).protocolVersion, 2);
    assert.equal(decodeWorkbenchTranscriptRequest(method, { ...input, protocolVersion: 0 })?.success, false);
    assert.equal(decodeWorkbenchTranscriptRequest(method, { ...input, protocolVersion: 3 })?.success, true);
    assert.equal(decodeWorkbenchTranscriptRequest(method, { ...input, protocolVersion: 4 })?.success, false);
  }
});

test("transcript requests resolve exact shared operation values and decode their params", () => {
  const decoded = decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.read.method,
    { threadId: " thread ", turnLimit: 20, futureOption: true },
  );
  assert.equal(decoded?.success, true);
  if (!decoded?.success) return;
  assert.equal(decoded.data.operation, workbenchTranscriptOperations.read);
  assert.deepEqual(decoded.data.params, { threadId: "thread", turnLimit: 20 });

  const malformed = decodeWorkbenchTranscriptRequest(workbenchTranscriptOperations.read.method, {
    threadId: "thread",
    turnLimit: "20",
  });
  assert.equal(malformed?.success, false);
  assert.equal(decodeWorkbenchTranscriptRequest("workbench/transcript/read/fake", {}), null);
});

test("parity reports admit only bounded content-free diagnostic context", () => {
  const context = {
    id: "item",
    index: 0,
    kind: "item",
    payloadSignature: "abc123",
    turnId: "turn",
    type: "agentMessage",
  };
  const diagnostic = {
    threadId: "thread",
    scope: "item",
    mismatch: "payload",
    jsonContext: [context],
    sqliteContext: [],
  };
  const decoded = decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportParity.method,
    diagnostic,
  );
  assert.equal(decoded?.success, true);
  if (decoded?.success) {
    assert.equal(decoded.data.operation, workbenchTranscriptOperations.reportParity);
    assert.deepEqual(decoded.data.params, diagnostic);
  }

  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportParity.method,
    { ...diagnostic, threadId: "thread\nsecret" },
  )?.success, false);
  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportParity.method,
    {
      ...diagnostic,
      jsonContext: [{ ...context, turnId: "turn\nsecret" }],
    },
  )?.success, false);
  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportParity.method,
    { ...diagnostic, jsonContext: Array.from({ length: 8 }, () => context) },
  )?.success, false);
});

test("conformance reports admit only bounded structural paths without payload values", () => {
  const diagnostic = {
    issues: [{ code: "invalidValue", path: ["rows", "threadItems", 2, "type"] }],
    method: "workbench/transcript/updated",
    repairedPaths: [["rows", "threadTurns"]],
  };
  const decoded = decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportConformance.method,
    diagnostic,
  );
  assert.equal(decoded?.success, true);
  if (decoded?.success) {
    assert.equal(decoded.data.operation, workbenchTranscriptOperations.reportConformance);
    assert.deepEqual(decoded.data.params, diagnostic);
  }

  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportConformance.method,
    { ...diagnostic, method: "workbench/transcript/updated\nsecret" },
  )?.success, false);
  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportConformance.method,
    { ...diagnostic, repairedPaths: [[{ payload: "secret" }]] },
  )?.success, false);
  assert.equal(decodeWorkbenchTranscriptRequest(
    workbenchTranscriptOperations.reportConformance.method,
    { ...diagnostic, issues: Array.from({ length: 65 }, () => diagnostic.issues[0]) },
  )?.success, false);
});

test("transcript snapshot conformance supplies missing augmentation collections from the table registry", () => {
  const result = conformWorkbenchTranscriptSnapshot({
    thread,
    turns: [],
    loadedTurnIds: [],
    hasPreviousTurns: false,
    rows: {},
    futureRoot: true,
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.thread, { ...thread, identity_origin: "legacy" });
  assert.deepEqual(Object.keys(result.data.rows), Object.keys(transcriptSnapshotTables));
  assert.ok(Object.values(result.data.rows).every((rows) => rows.length === 0));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "futureRoot"));
  assert.ok(result.repairedPaths.some((path) => path.join(".") === "rows.threadItems"));
});

test("transcript operation result conformance rejects method-matched malformed payloads", () => {
  const result = workbenchTranscriptOperations.read.conformResult({
    snapshot: {
      thread: { ...thread, archived: "false" },
      turns: [],
      loadedTurnIds: [],
      hasPreviousTurns: false,
      rows: {},
    },
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.path.join(".") === "snapshot.thread.archived"));
  }
});

test("transcript result and update conformance preserve explicit pre-materialization absence", () => {
  const read = workbenchTranscriptOperations.read.conformResult({
    snapshot: null,
    futureField: true,
  });
  assert.equal(read.success, true);
  if (read.success) {
    assert.equal(read.data.snapshot, null);
    assert.deepEqual(read.repairedPaths, [["futureField"]]);
  }
});

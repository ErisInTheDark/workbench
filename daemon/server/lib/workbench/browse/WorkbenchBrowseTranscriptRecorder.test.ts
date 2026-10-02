/*
 * No production exports. Tests protect provider-independent Browse transcript recording: verified assets, rejection, and notification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import * as identity from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../../../database/workbench-database-schema.ts";
import WorkbenchTranscriptAssetStore from "../../../database/transcript/WorkbenchTranscriptAssetStore.ts";
import WorkbenchTranscriptRepository from "../../../database/transcript/WorkbenchTranscriptRepository.ts";
import type { WorkbenchTranscriptObservation } from "../../../database/transcript/workbench-transcript-types.ts";
import WorkbenchBrowseTranscriptRecorder from "./WorkbenchBrowseTranscriptRecorder.ts";

const threadId = identity.WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-0000000000a1");
const turnId = identity.WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-0000000000a2");

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  new WorkbenchTranscriptRepository(database).settle([{
    activityAt: 1, createdAt: 1, kind: "thread", projectId: testProjectIds.project, projectRoot: "C:/project",
    threadId, title: "browse", updatedAt: 1,
  }]);
  const store = new WorkbenchTranscriptAssetStore(database);
  const recorded: WorkbenchTranscriptObservation[] = [];
  const notified: object[] = [];
  const recorder = new WorkbenchBrowseTranscriptRecorder({
    assets: { readTranscriptAsset: async (input) => store.read(input) },
    transcript: { record: async (observations) => { recorded.push(...observations); return { changedThreadIds: [threadId] }; } },
    notify: (harness, notification) => { notified.push({ harness, ...notification }); },
  });
  return { database, store, recorded, notified, recorder };
}

const entry = (assetUrl: string | null): WorkbenchBrowseResultEntry => ({
  action: "screenshot", actionIndex: 0, assetUrl, commandItemId: null, detailKind: "result", detailLabel: "Screenshot",
  detailText: null, durationMs: 12, entryKey: "browse-entry", recordedAt: 100, session: "research", state: "completed",
  threadId, turnId,
});

test("any provider's screenshot result records with its verified asset and announces it", async () => {
  const { database, store, recorded, notified, recorder } = fixture();
  try {
    const bytes = Buffer.from("verified browse image");
    const asset = store.write({ threadId, bytes, mimeType: "image/png" });
    await recorder.record(entry(asset.assetUrl), "claude");
    assert.deepEqual(recorded, [{
      kind: "browse", entry: entry(asset.assetUrl),
      asset: { byteLength: bytes.byteLength, digest: asset.digest, mimeType: "image/png", storageKey: asset.assetUrl },
    }]);
    assert.deepEqual(notified, [{ harness: "claude", method: "browse/result/recorded", params: { threadId, turnId } }]);
  } finally { database.close(); }
});

test("tampered or foreign screenshot assets are rejected before anything is recorded", async () => {
  const { database, store, recorded, notified, recorder } = fixture();
  try {
    const asset = store.write({ threadId, bytes: Buffer.from("original"), mimeType: "image/png" });
    database.prepare("UPDATE transcript_asset_content SET bytes = ? WHERE digest = ?").run(Buffer.from("tampered"), asset.digest);
    await assert.rejects(recorder.record(entry(asset.assetUrl), "codex"), /bytes do not match/u);
    await assert.rejects(recorder.record(entry("/elsewhere/image.png"), "codex"), /not a Workbench transcript asset/u);
    assert.deepEqual(recorded, []);
    assert.deepEqual(notified, []);
  } finally { database.close(); }
});

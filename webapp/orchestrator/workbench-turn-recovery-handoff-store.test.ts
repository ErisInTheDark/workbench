/*
 * No production exports. Node tests protect bounded, fresh, unique, atomic manual-resume handoffs. Keywords: recovery, handoff, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchTurnRecoveryHandoffStore, { type WorkbenchTurnRecoveryHandoff } from "./WorkbenchTurnRecoveryHandoffStore";
import { createWorkbenchThreadRecoveryId } from "workbench-shared/workbench/thread/thread-recovery-message";

function handoff(count: number, createdAt = Date.now()): WorkbenchTurnRecoveryHandoff {
  return {
    candidates: Array.from({ length: count }, (_, index) => ({
      harness: "codex" as const,
      key: `codex:thread-${index}`,
      lastEventAt: createdAt,
      recoveryId: createWorkbenchThreadRecoveryId(`recovery-${index}`),
      request: { id: index, method: "turn/start", params: { input: [], threadId: `thread-${index}` } },
      resumeRequest: { method: "thread/resume", params: { threadId: `thread-${index}` } },
      startedAt: createdAt,
      threadId: `thread-${index}`,
      turnId: null,
    })),
    createdAt,
    generation: createWorkbenchThreadRecoveryId("generation"),
    id: createWorkbenchThreadRecoveryId("handoff"),
    kind: "manual-resume",
    schemaVersion: 2,
  };
}

test("handoff store round-trips bounded state and removes empty progress", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-handoff-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const value = handoff(2);
  await store.write(value);
  assert.deepEqual(await store.load(), value);
  await store.updateCandidates(value, []);
  assert.equal(await store.load(), null);
});

test("handoff store rejects oversized and expired data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-handoff-invalid-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  await assert.rejects(store.write(handoff(11)), /safety limit/u);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, JSON.stringify(handoff(1, Date.now() - 11 * 60 * 1000)), "utf8");
  assert.equal(await store.load(), null);
});

test("handoff store fails closed for duplicate, malformed, and legacy automatic-restart state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-handoff-corrupt-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const duplicate = handoff(2);
  duplicate.candidates[1] = structuredClone(duplicate.candidates[0]!);
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, JSON.stringify(duplicate), "utf8");
  assert.equal(await store.load(), null);

  const malformed = handoff(1) as WorkbenchTurnRecoveryHandoff & { generation?: string };
  delete malformed.generation;
  await fs.writeFile(store.filePath, JSON.stringify(malformed), "utf8");
  assert.equal(await store.load(), null);

  const legacy = { ...handoff(1), kind: undefined, schemaVersion: 1 };
  await fs.writeFile(store.filePath, JSON.stringify(legacy), "utf8");
  assert.equal(await store.load(), null);
});

test("schema-v2 Codex handoffs without resume data gain a compatible request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-handoff-compatible-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const value = handoff(1);
  delete value.candidates[0]!.resumeRequest;
  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, JSON.stringify(value), "utf8");
  assert.deepEqual((await store.load())?.candidates[0]?.resumeRequest, {
    method: "thread/resume",
    params: { threadId: "thread-0" },
  });
});

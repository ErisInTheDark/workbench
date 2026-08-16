/*
 * No production exports. Node tests protect live-only admission, goal exclusion, recency caps, and progress retirement. Keywords: recovery, registry, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchTurnRecoveryController, { MAX_AUTOMATIC_RECOVERY_THREADS } from "./WorkbenchTurnRecoveryController";
import WorkbenchTurnRecoveryHandoffStore from "./WorkbenchTurnRecoveryHandoffStore";

test("controller admits only observed starts, excludes goals, and keeps newest ten", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-controller-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  for (let index = 0; index < 12; index += 1) {
    controller.observeRequest("codex", { id: index, method: "turn/start", params: { input: [], threadId: `thread-${index}` } }, index);
  }
  controller.observeRequest("codex", { id: 20, method: "thread/goal/set", params: { threadId: "thread-11" } }, 20);
  const captured = controller.capture(["codex"]);
  assert.equal(captured.length, MAX_AUTOMATIC_RECOVERY_THREADS);
  assert.equal(captured.some((candidate) => candidate.threadId === "thread-11"), false);
  assert.equal(captured[0]?.threadId, "thread-10");
});

test("terminal notifications retire the exact candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-terminal-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("opencode", { id: 1, method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("opencode", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } });
  assert.deepEqual(controller.capture(["opencode"]), []);
});

test("late completion for an older turn cannot retire a newer candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-late-terminal-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: 1, method: "turn/start", params: { input: [], threadId: "thread" } });
  controller.observeNotification("codex", { method: "turn/started", params: { threadId: "thread", turn: { id: "new-turn" } } });
  controller.observeNotification("codex", { method: "turn/completed", params: { threadId: "thread", turn: { id: "old-turn" } } });
  assert.equal(controller.capture(["codex"])[0]?.turnId, "new-turn");
});

test("handoff recovery failures publish once and retire the failed candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-progress-"));
  const store = new WorkbenchTurnRecoveryHandoffStore(root);
  const controller = new WorkbenchTurnRecoveryController(store, () => undefined);
  controller.observeRequest("codex", { id: 1, method: "turn/start", params: { input: [], threadId: "first" } }, 2);
  controller.observeRequest("codex", { id: 2, method: "turn/start", params: { input: [], threadId: "second" } }, 1);
  const handoff = await controller.persistControlledRestart();
  let calls = 0;
  const failures: string[] = [];
  const reportingController = new WorkbenchTurnRecoveryController(store, () => undefined, async (candidate) => { failures.push(candidate.threadId); });
  reportingController.loadCandidates(handoff.candidates);
  await reportingController.recover(handoff.candidates, async () => {
    calls += 1;
    if (calls === 2) throw new Error("recovery failed");
    return "recovered";
  }, handoff);
  const persisted = await store.load();
  assert.equal(persisted, null);
  assert.deepEqual(failures, ["second"]);
});

test("recovery cannot retire a replacement candidate registered for the same thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-replacement-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: "original", method: "turn/start", params: { input: [], threadId: "thread" } });
  const original = controller.capture(["codex"])[0];
  assert.ok(original);

  await controller.recover([original], async () => {
    controller.observeRequest("codex", { id: "recovery-start", method: "turn/start", params: { input: [], threadId: "thread" } });
    return "recovered";
  });

  const replacement = controller.capture(["codex"])[0];
  assert.ok(replacement);
  assert.notEqual(replacement.recoveryId, original.recoveryId);
});

test("busy recovery candidates remain registered", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-recovery-busy-"));
  const controller = new WorkbenchTurnRecoveryController(new WorkbenchTurnRecoveryHandoffStore(root), () => undefined);
  controller.observeRequest("codex", { id: "busy", method: "turn/start", params: { input: [], threadId: "thread" } });
  const candidate = controller.capture(["codex"])[0];
  assert.ok(candidate);

  await controller.recover([candidate], async () => "busy");

  assert.equal(controller.capture(["codex"])[0]?.recoveryId, candidate.recoveryId);
});

/*
 * No production exports. Node tests protect Codex recovery deduplication, cold-resume order, and stop-on-failure behavior. Keywords: codex, recovery, resume, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { recoverCodexTurn } from "./codex-turn-recovery";
import type { WorkbenchTurnRecoveryHandoffCandidate } from "./WorkbenchTurnRecoveryHandoffStore";

function candidate(): WorkbenchTurnRecoveryHandoffCandidate {
  return {
    harness: "codex",
    key: "codex:thread",
    lastEventAt: 1,
    recoveryId: "workbench-recovery:test",
    request: { id: "original", method: "turn/start", params: { cwd: "C:/repo", input: [], threadId: "thread" } },
    resumeRequest: { method: "thread/resume", params: { model: "gpt", threadId: "thread" }, workbenchPromptContext: { workflowIds: ["default"] } },
    startedAt: 1,
    threadId: "thread",
    turnId: "original-turn",
  };
}

function terminalThread() {
  return { thread: { turns: [{ id: "original-turn", items: [], status: "interrupted" }] } };
}

test("Codex recovery delegates the captured prefix and replacement input to one managed admission", async () => {
  const operations: string[] = [];
  let admissionParams: Record<string, unknown> | null = null;
  await recoverCodexTurn(candidate(), {
    request: async (request) => {
      operations.push(request.method);
      if (request.method === "thread/read") return { id: request.id, result: terminalThread() };
      admissionParams = request.params as Record<string, unknown>;
      return { id: request.id, result: { kind: "started", turn: { id: "replacement" } } };
    },
  });
  assert.deepEqual(operations, ["thread/read", "workbench/codex/message/admit"]);
  assert.deepEqual((admissionParams as { resumeRequest?: unknown } | null)?.resumeRequest, candidate().resumeRequest);
  const startRequest = (admissionParams as {
    startRequest?: { method?: string; params?: { clientUserMessageId?: string; input?: unknown[]; threadId?: string } };
  } | null)?.startRequest;
  assert.equal(startRequest?.method, "turn/start");
  assert.equal(startRequest?.params?.clientUserMessageId, "workbench-recovery:test");
  assert.equal(startRequest?.params?.threadId, "thread");
  assert.equal(startRequest?.params?.input?.length, 1);
});

test("Codex recovery stops before managed admission when the authoritative thread read fails", async () => {
  const methods: string[] = [];
  await assert.rejects(recoverCodexTurn(candidate(), {
    request: async (request) => {
      methods.push(request.method);
      return { error: { code: -32000, message: "read failed" }, id: request.id };
    },
  }), /read failed/u);
  assert.deepEqual(methods, ["thread/read"]);
});

test("Codex recovery propagates managed admission failure", async () => {
  const methods: string[] = [];
  await assert.rejects(recoverCodexTurn(candidate(), {
    request: async (request) => {
      methods.push(request.method);
      if (request.method === "thread/read") return { id: request.id, result: terminalThread() };
      return { error: { code: -32000, message: "resume failed" }, id: request.id };
    },
  }), /resume failed/u);
  assert.deepEqual(methods, ["thread/read", "workbench/codex/message/admit"]);
});

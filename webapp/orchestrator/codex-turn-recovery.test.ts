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

test("Codex recovery refreshes MCP and cold-resumes before starting the replacement turn", async () => {
  const operations: string[] = [];
  await recoverCodexTurn(candidate(), {
    prepareMcp: async () => { operations.push("prepareMcp"); },
    request: async (request) => {
      operations.push(request.method);
      return request.method === "thread/read" ? { id: request.id, result: terminalThread() } : { id: request.id, result: {} };
    },
  });
  assert.deepEqual(operations, ["thread/read", "prepareMcp", "thread/unsubscribe", "thread/resume", "turn/start"]);
});

test("Codex recovery stops before unsubscribe when MCP refresh fails", async () => {
  const methods: string[] = [];
  await assert.rejects(recoverCodexTurn(candidate(), {
    prepareMcp: async () => { throw new Error("refresh failed"); },
    request: async (request) => {
      methods.push(request.method);
      return { id: request.id, result: terminalThread() };
    },
  }), /refresh failed/u);
  assert.deepEqual(methods, ["thread/read"]);
});

test("Codex recovery stops before replacement start when resume fails", async () => {
  const methods: string[] = [];
  await assert.rejects(recoverCodexTurn(candidate(), {
    prepareMcp: async () => undefined,
    request: async (request) => {
      methods.push(request.method);
      if (request.method === "thread/read") return { id: request.id, result: terminalThread() };
      if (request.method === "thread/resume") return { error: { code: -32000, message: "resume failed" }, id: request.id };
      return { id: request.id, result: {} };
    },
  }), /resume failed/u);
  assert.deepEqual(methods, ["thread/read", "thread/unsubscribe", "thread/resume"]);
});

/*
 * No production exports. Node tests protect OpenCode completed, busy, prompt, and deterministic recovery branches.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { createWorkbenchThreadRecoveryId, createWorkbenchThreadRecoveryInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import {
  createOpenCodeReasoningConfig,
  createOpenCodeRecoveryStartRequest,
  getOpenCodeRecoveryDisposition,
  readOpenCodeSessionReasoningEffort,
} from "./opencode-bridge";
import type { WorkbenchTurnRecoveryHandoffCandidate } from "./WorkbenchTurnRecoveryHandoffStore";

const startedAt = 10_000;
const recoveryId = createWorkbenchThreadRecoveryId("opencode-recovery");
const candidate: WorkbenchTurnRecoveryHandoffCandidate = {
  harness: "opencode",
  key: "opencode:session",
  lastEventAt: startedAt,
  recoveryId,
  request: {
    id: 1,
    method: "turn/start",
    params: { agentPath: "agent://lily.md", cwd: "C:/workspace", input: [{ text: "original", text_elements: [], type: "text" }], model: "provider/model", threadId: "session" },
    workbenchPromptContext: { marker: "preserved" },
  },
  startedAt,
  threadId: "session",
  turnId: "original-turn",
};

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/workspace",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: "session",
    modelProvider: "opencode",
    model: null,
    projectId: null,
    reasoningEffort: null,
    name: null,
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: [{ completedAt: null, durationMs: null, error: null, id: "original-turn", items: [], itemsView: "full", startedAt: startedAt / 1000, status: "interrupted" }],
    updatedAt: 1,
    ...overrides,
  };
}

test("OpenCode recovery retires completed or already-marked work and reattaches to busy work", () => {
  assert.equal(getOpenCodeRecoveryDisposition(thread({ turns: [{ ...thread().turns[0]!, completedAt: 11, status: "completed" }] }), candidate), "completed");
  assert.equal(getOpenCodeRecoveryDisposition(thread({ status: { activeFlags: [], type: "active" } }), candidate), "busy");
  const markerTurn = {
    ...thread().turns[0]!,
    items: [{ clientId: null, content: createWorkbenchThreadRecoveryInput(), id: `opencode:user:${recoveryId}`, type: "userMessage" as const }],
  };
  assert.equal(getOpenCodeRecoveryDisposition(thread({ turns: [markerTurn] }), candidate), "completed");
});

test("OpenCode recovery prompts only incomplete idle work with preserved settings and deterministic identity", () => {
  assert.equal(getOpenCodeRecoveryDisposition(thread(), candidate), "prompt");
  const request = createOpenCodeRecoveryStartRequest(candidate);
  assert.deepEqual(request.workbenchPromptContext, { marker: "preserved" });
  assert.deepEqual(request.params, {
    agentPath: "agent://lily.md",
    clientUserMessageId: recoveryId,
    cwd: "C:/workspace",
    input: createWorkbenchThreadRecoveryInput(),
    model: "provider/model",
    threadId: "session",
  });
});

test("OpenCode effort adapter writes the SDK prompt variant and reads the admitted session variant", () => {
  assert.deepEqual(createOpenCodeReasoningConfig("medium"), { variant: "medium" });
  assert.deepEqual(createOpenCodeReasoningConfig(null), {});
  const session = { model: { id: "model", providerID: "provider", variant: "medium" } } as Session;
  assert.equal(readOpenCodeSessionReasoningEffort(session), "medium");
});

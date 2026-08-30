/*
 * Exports:
 * - CodexTurnRecoveryPort: direct Codex request boundary used during turn replacement. Keywords: codex, recovery, port.
 * - recoverCodexTurn: deduplicate, interrupt, and delegate replacement to managed admission. Keywords: codex, recovery, resume.
 */
import type { ThreadReadResponse } from "../lib/codex/generated/app-server/v2/ThreadReadResponse";
import { getCurrentTurn } from "../lib/codex/thread-state";
import { createWorkbenchThreadRecoveryInput, isWorkbenchThreadRecoveryUserMessage } from "../lib/workbench/thread/thread-recovery-message";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { WorkbenchTurnRecoveryHandoffCandidate } from "./WorkbenchTurnRecoveryHandoffStore";

export interface CodexTurnRecoveryPort {
  request(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readThread(response: JsonRpcResponse, candidate: WorkbenchTurnRecoveryHandoffCandidate) {
  if (response.error) throw new Error(response.error.message);
  const thread = record(response.result)?.thread;
  if (!thread || typeof thread !== "object") throw new Error(`Recovery could not read Codex thread ${candidate.threadId}.`);
  return thread as ThreadReadResponse["thread"];
}

function containsRecoveryMarker(thread: ThreadReadResponse["thread"], recoveryId: string) {
  return thread.turns.some((turn) => turn.items.some((item) => (
    item.type === "userMessage"
    && item.clientId === recoveryId
    && isWorkbenchThreadRecoveryUserMessage(item)
  )));
}

async function readRecoveryThread(candidate: WorkbenchTurnRecoveryHandoffCandidate, port: CodexTurnRecoveryPort) {
  return readThread(await port.request({
    id: `recovery-read:${candidate.recoveryId}`,
    method: "thread/read",
    params: {
      includeTurns: true,
      ...record(candidate.request.params),
      threadId: candidate.threadId,
    },
    workbenchThreadHydration: { mode: "latest" },
  }), candidate);
}

async function requireSuccess(port: CodexTurnRecoveryPort, request: JsonRpcRequest) {
  const response = await port.request(request);
  if (response.error) throw new Error(response.error.message);
}

export async function recoverCodexTurn(candidate: WorkbenchTurnRecoveryHandoffCandidate, port: CodexTurnRecoveryPort) {
  if (candidate.harness !== "codex" || !candidate.resumeRequest) throw new Error("Codex recovery requires a captured thread/resume request.");
  let thread = await readRecoveryThread(candidate, port);
  if (containsRecoveryMarker(thread, candidate.recoveryId)) return "completed" as const;
  const originalTurn = candidate.turnId ? thread.turns.find((turn) => turn.id === candidate.turnId) ?? null : null;
  if (originalTurn?.status === "completed") return "completed" as const;

  const currentTurn = getCurrentTurn(thread);
  if (currentTurn?.status === "inProgress") {
    await requireSuccess(port, {
      id: `recovery-interrupt:${candidate.recoveryId}`,
      method: "turn/interrupt",
      params: { threadId: candidate.threadId, turnId: currentTurn.id },
    });
    thread = await readRecoveryThread(candidate, port);
    if (getCurrentTurn(thread)?.status === "inProgress") throw new Error(`Interrupted Codex turn ${currentTurn.id} did not reach a terminal state.`);
  }
  if (containsRecoveryMarker(thread, candidate.recoveryId)) return "completed" as const;

  const startRequest = structuredClone(candidate.request);
  startRequest.id = `recovery-start:${candidate.recoveryId}`;
  startRequest.params = {
    ...record(startRequest.params),
    clientUserMessageId: candidate.recoveryId,
    input: createWorkbenchThreadRecoveryInput(),
    threadId: candidate.threadId,
  };
  await requireSuccess(port, {
    id: `recovery-admit:${candidate.recoveryId}`,
    method: "workbench/codex/message/admit",
    params: {
      resumeRequest: structuredClone(candidate.resumeRequest),
      startRequest,
      threadId: candidate.threadId,
    },
  });
  return "recovered" as const;
}

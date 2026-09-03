/*
 * Exports:
 * - CodexMessageRequestClient: minimal transport used by existing Codex message admission. Keywords: codex, message, transport.
 * - ThreadMessageAdmissionLifecycleState: client lifecycle values that fence message preparation. Keywords: message, lifecycle, fence.
 * - ThreadMessageAdmissionRequest: resume/start/steer adapters for one existing Codex admission. Keywords: resume, start, steer, adapter.
 * - ThreadMessageAdmissionResult: admitted steer or started-turn result. Keywords: message, admission, result.
 * - ThreadMessageAdmissionTarget: exact source and selection ownership for one Codex admission. Keywords: codex, message, target, selection.
 * - ThreadMessageAdmissionController: existing Codex message admission owner. Keywords: codex, message, admission, controller.
 * - default ThreadMessageAdmissionController: create the message admission owner. Keywords: codex, message, create.
 */

import type { ThreadResumeParams } from "workbench-shared/codex/generated/app-server/v2/ThreadResumeParams";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { TurnStartParams } from "workbench-shared/codex/generated/app-server/v2/TurnStartParams";
import type { TurnSteerParams } from "workbench-shared/codex/generated/app-server/v2/TurnSteerParams";
import type { TurnSteerResponse } from "workbench-shared/codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import type { CodexJsonRpcResponse } from "workbench-shared/codex/protocol";
import { isCodexJsonRpcFailure } from "workbench-shared/codex/protocol";
import { getCurrentInProgressTurn, isThreadStatusActive } from "workbench-shared/codex/thread-state";
import type { ThreadPayload } from "workbench-shared/types";
import type { ThreadDocumentStore as ThreadDocumentStoreApi } from "../state/ThreadDocumentStore";
import type { ThreadSourceStore } from "../state/ThreadSourceStore";
import type { ThreadOptimisticInputStore } from "./ThreadOptimisticInputStore";
import { ThreadMessageNotSentError } from "./thread-message-submission";

type CodexRequest = { method: string; params?: unknown } & Record<string, unknown>;
type ManagedMessageAdmissionResponse =
  | { kind: "started"; turn: Turn }
  | { kind: "steered"; turnId: string };

export interface CodexMessageRequestClient {
  connect: () => Promise<void>;
  sendRequest: <TResponse = unknown>(message: CodexRequest) => Promise<CodexJsonRpcResponse<TResponse>>;
}

export interface ThreadMessageAdmissionLifecycleState {
  disposed: boolean;
  messageAdmissionIntentRevision: number;
  projectContextGeneration: number;
  projectId: string;
  projectRootPath: string;
}

export interface ThreadMessageAdmissionTarget {
  readonly selectionBound: boolean;
  readonly startNewTurn: boolean;
  readonly threadKey: string;
}

export interface ThreadMessageAdmissionRequest {
  projectStartedTurn: (context: {
    clientUserMessageId: string;
    input: UserInput[];
    projectContextGeneration: number;
    sourceRevision: number;
    threadKey: string;
    turn: Turn;
  }) => void;
  resumeRequest: CodexRequest & { method: "thread/resume"; params: ThreadResumeParams };
  startRequest: CodexRequest & {
    method: "turn/start";
    params: Omit<TurnStartParams, "clientUserMessageId" | "input" | "threadId">;
  };
  steerRequest: CodexRequest & {
    method: "turn/steer";
    params: Omit<TurnSteerParams, "clientUserMessageId" | "expectedTurnId" | "input" | "threadId">;
  };
}

export type ThreadMessageAdmissionResult =
  | { handle: string; kind: "admitted" }
  | { acknowledgedTurnId: string; handle: string; kind: "admittedNeedsReconciliation" }
  | { clientUserMessageId: string; kind: "turnStarted"; turn: Turn };

interface ThreadMessageAdmissionControllerOptions {
  client: CodexMessageRequestClient;
  documents: ThreadDocumentStoreApi;
  emitWarning: (message: string) => void;
  getLifecycleState: (threadId: string) => ThreadMessageAdmissionLifecycleState;
  getThreadStatus: (thread: ThreadPayload) => string;
  optimisticInputs: ThreadOptimisticInputStore;
  publishAccepted?: (event: { correlationHandle: string; projectId: string; threadId: string; title: string; turnId: string }) => void;
  renderSource: (key: string) => void;
  sources: ThreadSourceStore;
}

interface AdmissionCapture extends ThreadMessageAdmissionLifecycleState {
  selectionBound: boolean;
  startNewTurn: boolean;
  threadKey: string;
  threadId: string;
}

function ThreadMessageAdmissionController({
  client,
  documents,
  emitWarning,
  getLifecycleState,
  getThreadStatus,
  optimisticInputs,
  publishAccepted,
  renderSource,
  sources,
}: ThreadMessageAdmissionControllerOptions) {
  function reportAccepted(capture: AdmissionCapture, correlationHandle: string, turnId: string, input: UserInput[]) {
    const title = capture.selectionBound
      ? "New thread"
      : input.find((entry) => entry.type === "text")?.text ?? "New thread";
    publishAccepted?.({ correlationHandle, projectId: capture.projectId, threadId: capture.threadId, title, turnId });
  }
  function captureOwner(threadId: string, target?: ThreadMessageAdmissionTarget): AdmissionCapture {
    const lifecycle = getLifecycleState(threadId);
    const selectedThreadKey = documents.getSelectedThreadKey();
    const threadKey = target?.threadKey ?? selectedThreadKey;
    const selectionBound = target?.selectionBound ?? true;
    const thread = threadKey ? sources.get(threadKey) : null;
    if (
      lifecycle.disposed
      || !threadKey
      || !thread
      || thread.harness !== "codex"
      || thread.isDraft
      || thread.id !== threadId
      || (selectionBound && selectedThreadKey !== threadKey)
    ) {
      throw new ThreadMessageNotSentError();
    }

    return {
      ...lifecycle,
      selectionBound,
      startNewTurn: target?.startNewTurn ?? false,
      threadId,
      threadKey,
    };
  }

  function revalidateOwner(expected: AdmissionCapture) {
    const current = captureOwner(expected.threadId, expected);
    if (
      current.projectContextGeneration !== expected.projectContextGeneration
      || current.projectId !== expected.projectId
      || current.projectRootPath !== expected.projectRootPath
      || (expected.selectionBound && current.messageAdmissionIntentRevision !== expected.messageAdmissionIntentRevision)
      || current.threadKey !== expected.threadKey
    ) {
      throw new ThreadMessageNotSentError();
    }
    return current;
  }

  function isCapturedOwnerCurrent(expected: AdmissionCapture) {
    const lifecycle = getLifecycleState(expected.threadId);
    const thread = sources.get(expected.threadKey);
    return !lifecycle.disposed
      && lifecycle.projectContextGeneration === expected.projectContextGeneration
      && lifecycle.projectId === expected.projectId
      && lifecycle.projectRootPath === expected.projectRootPath
      && (!expected.selectionBound || lifecycle.messageAdmissionIntentRevision === expected.messageAdmissionIntentRevision)
      && (!expected.selectionBound || documents.getSelectedThreadKey() === expected.threadKey)
      && Boolean(thread);
  }

  function render(key: string) {
    try {
      renderSource(key);
    } catch (error) {
      emitWarning(`The message was queued, but its pending item could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function dispatchSteer(
    capture: AdmissionCapture,
    thread: ThreadPayload,
    input: UserInput[],
    request: ThreadMessageAdmissionRequest,
  ): Promise<ThreadMessageAdmissionResult> {
    const activeTurn = getCurrentInProgressTurn(thread);
    if (!activeTurn) {
      throw new ThreadMessageNotSentError();
    }

    const entry = optimisticInputs.enqueueSteer(thread, activeTurn.id, input);
    render(capture.threadKey);

    let response: CodexJsonRpcResponse<TurnSteerResponse>;
    try {
      response = await client.sendRequest<TurnSteerResponse>({
        ...request.steerRequest,
        params: {
          ...request.steerRequest.params,
          clientUserMessageId: entry.handle,
          expectedTurnId: activeTurn.id,
          input,
          threadId: capture.threadId,
        },
        workbenchHarness: "codex",
      });
    } catch (error) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(capture.threadKey)) {
        render(capture.threadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw error;
    }

    if (isCodexJsonRpcFailure(response)) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(capture.threadKey)) {
        render(capture.threadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw new Error(response.error.message);
    }

    const acknowledgedTurnId = typeof response.result?.turnId === "string"
      ? response.result.turnId.trim()
      : "";
    if (!acknowledgedTurnId) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(capture.threadKey)) {
        render(capture.threadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw new Error("turn/steer returned an empty turn id.");
    }

    if (!optimisticInputs.movePending(entry.handle, acknowledgedTurnId)) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (status === null && !isCapturedOwnerCurrent(capture)) {
        return { handle: entry.handle, kind: "admitted" };
      }
      if (sources.has(capture.threadKey)) {
        render(capture.threadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw new Error(status === "interrupted"
        ? "The turn stopped before this steer was delivered."
        : "The steer could not be admitted to the active turn.");
    }

    if (acknowledgedTurnId === activeTurn.id) {
      return { handle: entry.handle, kind: "admitted" };
    }
    if (sources.has(capture.threadKey)) {
      render(capture.threadKey);
    }
    emitWarning(`Codex admitted the steer to unexpected turn ${acknowledgedTurnId}; reconciling the thread.`);
    return { acknowledgedTurnId, handle: entry.handle, kind: "admittedNeedsReconciliation" };
  }

  async function dispatchStart(
    capture: AdmissionCapture,
    input: UserInput[],
    request: ThreadMessageAdmissionRequest,
  ): Promise<ThreadMessageAdmissionResult> {
    const clientUserMessageId = optimisticInputs.createClientUserMessageId();
    const sourceRevision = sources.getRevision(capture.threadKey);
    const startRequest = {
      ...request.startRequest,
      params: {
        ...request.startRequest.params,
        clientUserMessageId,
        input,
        threadId: capture.threadId,
      },
      workbenchHarness: "codex",
    };
    let response: CodexJsonRpcResponse<ManagedMessageAdmissionResponse>;
    try {
      response = await client.sendRequest<ManagedMessageAdmissionResponse>({
        method: "workbench/codex/message/admit",
        params: {
          resumeRequest: request.resumeRequest,
          startRequest,
          ...(!capture.startNewTurn ? { steerRequest: request.steerRequest } : {}),
          threadId: capture.threadId,
        },
        workbenchHarness: "codex",
      });
    } catch (error) {
      if (!isCapturedOwnerCurrent(capture)) throw new ThreadMessageNotSentError();
      throw error;
    }
    if (isCodexJsonRpcFailure(response)) {
      if (!isCapturedOwnerCurrent(capture)) throw new ThreadMessageNotSentError();
      throw new Error(response.error.message);
    }
    if (response.result?.kind === "steered") {
      const turnId = response.result.turnId.trim();
      if (!turnId) {
        if (!isCapturedOwnerCurrent(capture)) throw new ThreadMessageNotSentError();
        throw new Error("Managed message admission returned an empty steer turn id.");
      }
      reportAccepted(capture, clientUserMessageId, turnId, input);
      return { handle: clientUserMessageId, kind: "admitted" };
    }
    const turn = response.result?.kind === "started" ? response.result.turn : null;
    if (!turn || typeof turn.id !== "string" || !turn.id.trim()) {
      if (!isCapturedOwnerCurrent(capture)) throw new ThreadMessageNotSentError();
      throw new Error("turn/start returned an empty turn id.");
    }
    request.projectStartedTurn({
      clientUserMessageId,
      input,
      projectContextGeneration: capture.projectContextGeneration,
      sourceRevision,
      threadKey: capture.threadKey,
      turn,
    });
    reportAccepted(capture, clientUserMessageId, turn.id, input);
    return { clientUserMessageId, kind: "turnStarted", turn };
  }

  async function admit(
    threadId: string,
    input: UserInput[],
    request: ThreadMessageAdmissionRequest,
    target?: ThreadMessageAdmissionTarget,
  ): Promise<ThreadMessageAdmissionResult> {
    const initial = captureOwner(threadId, target);
    try {
      await client.connect();
    } catch (error) {
      if (!isCapturedOwnerCurrent(initial)) {
        throw new ThreadMessageNotSentError();
      }
      throw error;
    }
    const connected = revalidateOwner(initial);
    const connectedThread = sources.get(connected.threadKey);
    if (!connectedThread) {
      throw new ThreadMessageNotSentError();
    }
    if (
      !connected.startNewTurn
      && isThreadStatusActive(getThreadStatus(connectedThread))
      && getCurrentInProgressTurn(connectedThread)
    ) {
      return await dispatchSteer(connected, connectedThread, input, request);
    }

    return await dispatchStart(connected, input, request);
  }

  return { admit };
}

export default ThreadMessageAdmissionController;

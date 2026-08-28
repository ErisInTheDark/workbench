/*
 * Exports:
 * - CodexMessageRequestClient: minimal transport used by selected Codex message admission. Keywords: codex, message, transport.
 * - ThreadMessageAdmissionLifecycleState: client lifecycle values that fence message preparation. Keywords: message, lifecycle, fence.
 * - ThreadMessageAdmissionRequest: resume/start/steer adapters for one selected Codex admission. Keywords: resume, start, steer, adapter.
 * - ThreadMessageAdmissionResult: admitted steer or started-turn result. Keywords: message, admission, result.
 * - ThreadMessageAdmissionController: selected existing Codex message admission owner. Keywords: codex, message, admission, controller.
 * - default ThreadMessageAdmissionController: create the message admission owner. Keywords: codex, message, create.
 */

import type { ThreadResumeParams } from "../../codex/generated/app-server/v2/ThreadResumeParams";
import type { ThreadResumeResponse } from "../../codex/generated/app-server/v2/ThreadResumeResponse";
import type { Turn } from "../../codex/generated/app-server/v2/Turn";
import type { TurnStartParams } from "../../codex/generated/app-server/v2/TurnStartParams";
import type { TurnStartResponse } from "../../codex/generated/app-server/v2/TurnStartResponse";
import type { TurnSteerParams } from "../../codex/generated/app-server/v2/TurnSteerParams";
import type { TurnSteerResponse } from "../../codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import type { CodexJsonRpcResponse } from "../../codex/protocol";
import { isCodexJsonRpcFailure } from "../../codex/protocol";
import { getCurrentInProgressTurn, isThreadStatusActive } from "../../codex/thread-state";
import type { ThreadPayload } from "../../types";
import type { ThreadDocumentStore as ThreadDocumentStoreApi } from "../state/ThreadDocumentStore";
import type { ThreadSourceStore } from "../state/ThreadSourceStore";
import type { ThreadOptimisticInputStore } from "./ThreadOptimisticInputStore";
import { ThreadMessageNotSentError } from "./thread-message-submission";

type CodexRequest = { method: string; params?: unknown } & Record<string, unknown>;

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

export interface ThreadMessageAdmissionRequest {
  mergeAndInstallResumedThread: (thread: ThreadPayload, expectedSourceRevision: number) => ThreadPayload | null;
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
  toResumedThread: (response: ThreadResumeResponse) => ThreadPayload;
}

export type ThreadMessageAdmissionResult =
  | { handle: string; kind: "admitted" }
  | { acknowledgedTurnId: string; handle: string; kind: "admittedNeedsReconciliation" }
  | { clientUserMessageId: string; kind: "turnStarted"; turn: Turn };

interface ThreadMessageAdmissionControllerOptions {
  client: CodexMessageRequestClient;
  documents: ThreadDocumentStoreApi;
  emitWarning: (message: string) => void;
  getLifecycleState: () => ThreadMessageAdmissionLifecycleState;
  getThreadStatus: (thread: ThreadPayload) => string;
  optimisticInputs: ThreadOptimisticInputStore;
  publishAccepted?: (event: { correlationHandle: string; projectId: string; threadId: string; turnId: string }) => void;
  renderSource: (key: string) => void;
  sources: ThreadSourceStore;
}

interface AdmissionCapture extends ThreadMessageAdmissionLifecycleState {
  selectedThreadKey: string;
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
  function reportAccepted(capture: AdmissionCapture, correlationHandle: string, turnId: string) {
    publishAccepted?.({ correlationHandle, projectId: capture.projectId, threadId: capture.threadId, turnId });
  }
  function captureOwner(threadId: string): AdmissionCapture {
    const lifecycle = getLifecycleState();
    const selectedThreadKey = documents.getSelectedThreadKey();
    const thread = selectedThreadKey ? sources.get(selectedThreadKey) : null;
    if (
      lifecycle.disposed
      || !selectedThreadKey
      || !thread
      || thread.harness !== "codex"
      || thread.isDraft
      || thread.id !== threadId
    ) {
      throw new ThreadMessageNotSentError();
    }

    return { ...lifecycle, selectedThreadKey, threadId };
  }

  function revalidateOwner(expected: AdmissionCapture) {
    const current = captureOwner(expected.threadId);
    if (
      current.projectContextGeneration !== expected.projectContextGeneration
      || current.projectId !== expected.projectId
      || current.projectRootPath !== expected.projectRootPath
      || current.messageAdmissionIntentRevision !== expected.messageAdmissionIntentRevision
      || current.selectedThreadKey !== expected.selectedThreadKey
    ) {
      throw new ThreadMessageNotSentError();
    }
    return current;
  }

  function isCapturedOwnerCurrent(expected: AdmissionCapture) {
    const lifecycle = getLifecycleState();
    const thread = sources.get(expected.selectedThreadKey);
    return !lifecycle.disposed
      && lifecycle.projectContextGeneration === expected.projectContextGeneration
      && lifecycle.projectId === expected.projectId
      && lifecycle.projectRootPath === expected.projectRootPath
      && lifecycle.messageAdmissionIntentRevision === expected.messageAdmissionIntentRevision
      && documents.getSelectedThreadKey() === expected.selectedThreadKey
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
    render(capture.selectedThreadKey);

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
      if (sources.has(capture.selectedThreadKey)) {
        render(capture.selectedThreadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw error;
    }

    if (isCodexJsonRpcFailure(response)) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(capture.selectedThreadKey)) {
        render(capture.selectedThreadKey);
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
      if (sources.has(capture.selectedThreadKey)) {
        render(capture.selectedThreadKey);
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
      if (sources.has(capture.selectedThreadKey)) {
        render(capture.selectedThreadKey);
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
    if (sources.has(capture.selectedThreadKey)) {
      render(capture.selectedThreadKey);
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
    const sourceRevision = sources.getRevision(capture.selectedThreadKey);
    const response = await client.sendRequest<TurnStartResponse>({
      ...request.startRequest,
      params: {
        ...request.startRequest.params,
        clientUserMessageId,
        input,
        threadId: capture.threadId,
      },
      workbenchHarness: "codex",
    });
    if (isCodexJsonRpcFailure(response)) {
      throw new Error(response.error.message);
    }
    const turn = response.result?.turn;
    if (!turn || typeof turn.id !== "string" || !turn.id.trim()) {
      throw new Error("turn/start returned an empty turn id.");
    }
    request.projectStartedTurn({
      clientUserMessageId,
      input,
      projectContextGeneration: capture.projectContextGeneration,
      sourceRevision,
      threadKey: capture.selectedThreadKey,
      turn,
    });
    reportAccepted(capture, clientUserMessageId, turn.id);
    return { clientUserMessageId, kind: "turnStarted", turn };
  }

  async function admit(
    threadId: string,
    input: UserInput[],
    request: ThreadMessageAdmissionRequest,
  ): Promise<ThreadMessageAdmissionResult> {
    const initial = captureOwner(threadId);
    try {
      await client.connect();
    } catch (error) {
      if (!isCapturedOwnerCurrent(initial)) {
        throw new ThreadMessageNotSentError();
      }
      throw error;
    }
    const connected = revalidateOwner(initial);
    const connectedThread = sources.get(connected.selectedThreadKey);
    if (!connectedThread) {
      throw new ThreadMessageNotSentError();
    }
    if (isThreadStatusActive(getThreadStatus(connectedThread)) && getCurrentInProgressTurn(connectedThread)) {
      return await dispatchSteer(connected, connectedThread, input, request);
    }

    const connectedInProgressTurnId = getCurrentInProgressTurn(connectedThread)?.id ?? null;
    const resumeSourceRevision = sources.getRevision(connected.selectedThreadKey);
    let response: CodexJsonRpcResponse<ThreadResumeResponse>;
    try {
      response = await client.sendRequest<ThreadResumeResponse>({
        ...request.resumeRequest,
        workbenchHarness: "codex",
      });
    } catch (error) {
      if (!isCapturedOwnerCurrent(initial)) {
        throw new ThreadMessageNotSentError();
      }
      throw error;
    }
    const resumedOwner = revalidateOwner(initial);
    if (isCodexJsonRpcFailure(response)) {
      throw new Error(response.error.message);
    }
    if (!response.result?.thread) {
      throw new Error("thread/resume returned no thread.");
    }

    const currentSourceRevision = sources.getRevision(resumedOwner.selectedThreadKey);
    const sourceAdvancedDuringResume = currentSourceRevision !== resumeSourceRevision;
    const candidate = sourceAdvancedDuringResume
      ? sources.get(resumedOwner.selectedThreadKey)
      : request.mergeAndInstallResumedThread(request.toResumedThread(response.result), resumeSourceRevision);
    if (!candidate) {
      throw new ThreadMessageNotSentError();
    }

    const status = getThreadStatus(candidate);
    const candidateInProgressTurn = getCurrentInProgressTurn(candidate);
    const sourceIntroducedDifferentInProgressTurn = sourceAdvancedDuringResume
      && candidateInProgressTurn?.id !== connectedInProgressTurnId;
    if (
      candidateInProgressTurn
      && (sourceIntroducedDifferentInProgressTurn || isThreadStatusActive(status))
    ) {
      return await dispatchSteer(resumedOwner, candidate, input, request);
    }
    if (isThreadStatusActive(status)) {
      throw new ThreadMessageNotSentError();
    }
    return await dispatchStart(resumedOwner, input, request);
  }

  return { admit };
}

export default ThreadMessageAdmissionController;

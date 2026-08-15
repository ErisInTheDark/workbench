/*
 * Exports:
 * - CodexSteerRequestClient: minimal transport used by selected Codex steer admission. Keywords: codex, steer, transport.
 * - ThreadSteerAdmissionLifecycleState: client lifecycle values that fence steer preparation. Keywords: steer, lifecycle, fence.
 * - ThreadSteerAdmissionResult: admitted steer result and anomaly reconciliation signal. Keywords: steer, admission, result.
 * - ThreadSteerAdmissionController: selected active Codex steer admission owner. Keywords: codex, steer, admission, controller.
 * - default ThreadSteerAdmissionController: create the steer admission owner. Keywords: codex, steer, create.
 */

import type { TurnSteerResponse } from "../../codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import type { CodexJsonRpcResponse } from "../../codex/protocol";
import { isCodexJsonRpcFailure } from "../../codex/protocol";
import { isThreadStatusActive } from "../../codex/thread-state";
import type { ThreadDocumentStore as ThreadDocumentStoreApi } from "../state/ThreadDocumentStore";
import type { ThreadSourceStore } from "../state/ThreadSourceStore";
import type { ThreadOptimisticInputStore } from "./ThreadOptimisticInputStore";

export interface CodexSteerRequestClient {
  connect: () => Promise<void>;
  sendRequest: <TResponse = unknown>(message: { method: string; params?: unknown } & Record<string, unknown>) => Promise<CodexJsonRpcResponse<TResponse>>;
}

export interface ThreadSteerAdmissionLifecycleState {
  disposed: boolean;
  projectContextGeneration: number;
  projectId: string;
  projectRootPath: string;
  steerAdmissionIntentRevision: number;
}

export type ThreadSteerAdmissionResult =
  | { handle: string; kind: "admitted" }
  | { acknowledgedTurnId: string; handle: string; kind: "admittedNeedsReconciliation" };

export interface ThreadSteerAdmissionControllerOptions {
  client: CodexSteerRequestClient;
  documents: ThreadDocumentStoreApi;
  emitWarning: (message: string) => void;
  getLifecycleState: () => ThreadSteerAdmissionLifecycleState;
  optimisticInputs: ThreadOptimisticInputStore;
  renderSource: (key: string) => void;
  sources: ThreadSourceStore;
}

interface AdmissionCapture extends ThreadSteerAdmissionLifecycleState {
  activeTurnId: string;
  selectedThreadKey: string;
  threadId: string;
}

function getActiveNewestTurnId(thread: { turns: Array<{ id: string; status: string }> }) {
  const turn = thread.turns.at(-1);
  return turn?.status === "inProgress" ? turn.id : null;
}

function ThreadSteerAdmissionController({
  client,
  documents,
  emitWarning,
  getLifecycleState,
  optimisticInputs,
  renderSource,
  sources,
}: ThreadSteerAdmissionControllerOptions) {
  function capture(threadId: string): AdmissionCapture {
    const lifecycle = getLifecycleState();
    const selectedThreadKey = documents.getSelectedThreadKey();
    const thread = sources.get(selectedThreadKey);
    const activeTurnId = thread ? getActiveNewestTurnId(thread) : null;
    if (
      lifecycle.disposed
      || !selectedThreadKey
      || !thread
      || thread.harness !== "codex"
      || thread.isDraft
      || thread.id !== threadId
      || !isThreadStatusActive(thread.status)
      || !activeTurnId
    ) {
      throw new Error("The selected Codex thread is no longer ready to accept a steer.");
    }

    return { ...lifecycle, activeTurnId, selectedThreadKey, threadId };
  }

  function revalidate(expected: AdmissionCapture) {
    const current = capture(expected.threadId);
    if (
      current.projectContextGeneration !== expected.projectContextGeneration
      || current.projectId !== expected.projectId
      || current.projectRootPath !== expected.projectRootPath
      || current.steerAdmissionIntentRevision !== expected.steerAdmissionIntentRevision
      || current.selectedThreadKey !== expected.selectedThreadKey
      || current.activeTurnId !== expected.activeTurnId
    ) {
      throw new Error("The selected Codex thread changed before the steer could be admitted.");
    }
    return current;
  }

  function render(key: string) {
    try {
      renderSource(key);
    } catch (error) {
      emitWarning(`The steer was queued, but its pending message could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function admit(threadId: string, input: UserInput[]): Promise<ThreadSteerAdmissionResult> {
    const initial = capture(threadId);
    await client.connect();
    const ready = revalidate(initial);
    const thread = sources.get(ready.selectedThreadKey);
    if (!thread) {
      throw new Error("The selected Codex thread source disappeared before steer admission.");
    }

    const entry = optimisticInputs.enqueueSteer(thread, ready.activeTurnId, input);
    render(ready.selectedThreadKey);

    let response: CodexJsonRpcResponse<TurnSteerResponse>;
    try {
      response = await client.sendRequest<TurnSteerResponse>({
        method: "turn/steer",
        params: {
          clientUserMessageId: entry.handle,
          expectedTurnId: ready.activeTurnId,
          input,
          threadId,
        },
        workbenchHarness: "codex",
      });
    } catch (error) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(ready.selectedThreadKey)) {
        render(ready.selectedThreadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw error;
    }

    if (isCodexJsonRpcFailure(response)) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(ready.selectedThreadKey)) {
        render(ready.selectedThreadKey);
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
      if (sources.has(ready.selectedThreadKey)) {
        render(ready.selectedThreadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw new Error("turn/steer returned an empty turn id.");
    }

    if (!optimisticInputs.movePending(entry.handle, acknowledgedTurnId)) {
      const status = optimisticInputs.transition(entry.handle, "failed");
      if (sources.has(ready.selectedThreadKey)) {
        render(ready.selectedThreadKey);
      }
      if (status === "sent") {
        return { handle: entry.handle, kind: "admitted" };
      }
      throw new Error(status === "interrupted"
        ? "The turn stopped before this steer was delivered."
        : "The steer could not be admitted to the active turn.");
    }

    if (acknowledgedTurnId === ready.activeTurnId) {
      return { handle: entry.handle, kind: "admitted" };
    }
    if (sources.has(ready.selectedThreadKey)) {
      render(ready.selectedThreadKey);
    }
    emitWarning(`Codex admitted the steer to unexpected turn ${acknowledgedTurnId}; reconciling the thread.`);
    return { acknowledgedTurnId, handle: entry.handle, kind: "admittedNeedsReconciliation" };
  }

  return { admit };
}

export default ThreadSteerAdmissionController;

/*
 * Exports:
 * - WorkbenchQuestionnaireControllerOptions: ports for caller resolution, durable projection, and dismissal observation. Keywords: questionnaire, lifecycle, thread state.
 * - WorkbenchAnsweredQuestionnaire: one consumed questionnaire and its exact response. Keywords: questionnaire, answer, history.
 * - default WorkbenchQuestionnaireController: own pending Workbench questionnaire waits and correlation. Keywords: questionnaire, wait, cancellation, correlation.
 */
import { randomUUID } from "node:crypto";

import type { WorkbenchDurableQuestionnaire } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import type { WorkbenchPendingUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import {
  isWorkbenchAgentMcpRuntimeReloadInterruption,
} from "../lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchRequestUserInputCommandInput } from "../lib/workbench/commands/questionnaire-command-definition";

export interface WorkbenchQuestionnaireControllerOptions {
  clearPending(threadId: string, requestKey: string): Promise<void>;
  createRequestKey?: () => string;
  logError?: (message: string) => void;
  publishPending(threadId: string, questionnaire: WorkbenchDurableQuestionnaire): Promise<void>;
  resolveThread(cwd: string, threadId: string): Promise<{
    projectId: string;
    turnId: string;
    pendingQuestionnaire?: WorkbenchDurableQuestionnaire | null;
  }>;
  subscribePending(listener: (state: { projectId: string; requestKey: string | null; threadId: string }) => void): () => void;
}

export interface WorkbenchAnsweredQuestionnaire extends WorkbenchDurableQuestionnaire {
  response: WorkbenchUserInputResponse;
  threadId: string;
}

type PendingQuestionnaire = {
  cancelReason: unknown | null;
  completion: Promise<void>;
  projectId: string;
  projected: boolean;
  questionnaire: WorkbenchDurableQuestionnaire;
  reject: (error: unknown) => void;
  reloadReason: unknown | null;
  resolve: (response: WorkbenchUserInputResponse) => void;
  signal: AbortSignal;
  status: "waiting" | "responding" | "cancelling";
  stopAbort: (() => void) | null;
  threadId: string;
};

export default class WorkbenchQuestionnaireController {
  private disposed = false;
  private readonly options: WorkbenchQuestionnaireControllerOptions;
  private readonly pendingByThreadId = new Map<string, PendingQuestionnaire>();
  private readonly stopPendingSubscription: () => void;

  constructor(options: WorkbenchQuestionnaireControllerOptions) {
    this.options = options;
    this.stopPendingSubscription = options.subscribePending((state) => {
      const pending = this.pendingByThreadId.get(state.threadId);
      if (!pending) return;
      if (!pending.projected) {
        if (pending.questionnaire.requestKey !== state.requestKey) return;
        pending.projected = true;
      }
      if (
        pending.projectId !== state.projectId
        || pending.status !== "waiting"
        || pending.questionnaire.requestKey === state.requestKey
      ) {
        return;
      }
      void this.cancelPending(pending, new Error("The questionnaire was dismissed."));
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPendingSubscription();
    await Promise.all([...this.pendingByThreadId.values()].map(async (pending) => {
      if (pending.reloadReason !== null && pending.status === "responding") {
        await pending.completion;
        return;
      }
      await this.cancelPending(pending, new Error("The questionnaire controller was disposed."));
    }));
  }

  list() {
    return {
      data: [...this.pendingByThreadId.values()]
        .filter((pending) => pending.projected && pending.status !== "cancelling")
        .map((pending): Omit<WorkbenchPendingUserInputRequest, "harness" | "responseMode"> => ({
          itemId: pending.questionnaire.itemId,
          request: pending.questionnaire.request,
          requestKey: pending.questionnaire.requestKey,
          threadId: pending.threadId,
          turnId: pending.questionnaire.turnId,
        })),
    };
  }

  async request(input: WorkbenchRequestUserInputCommandInput, signal: AbortSignal): Promise<WorkbenchUserInputResponse> {
    this.assertActive();
    signal.throwIfAborted();
    if (this.pendingByThreadId.has(input.callerThreadId)) {
      throw new Error("This thread already has a pending questionnaire.");
    }

    const { projectId, turnId, pendingQuestionnaire } = await this.options.resolveThread(input.cwd, input.callerThreadId);
    this.assertActive();
    signal.throwIfAborted();
    if (this.pendingByThreadId.has(input.callerThreadId)) {
      throw new Error("This thread already has a pending questionnaire.");
    }

    const requestKey = input.requestKey
      ?? (this.options.createRequestKey ?? (() => `${WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX}${randomUUID()}`))();
    const restored = pendingQuestionnaire?.requestKey === requestKey ? pendingQuestionnaire : null;
    const questionnaire: WorkbenchDurableQuestionnaire = {
      itemId: restored?.itemId ?? randomUUID(),
      request: {
        id: requestKey,
        questions: input.questions.map((question) => ({
          allowOther: true,
          header: question.header,
          id: question.id,
          isSecret: false,
          options: question.options,
          question: question.question,
        })),
        submitLabel: "Submit",
        summary: "",
        title: getQuestionnaireTitle({ title: "Questionnaire", questions: input.questions }),
      },
      requestKey,
      turnId: restored?.turnId ?? turnId,
    };
    let resolve!: PendingQuestionnaire["resolve"];
    let reject!: PendingQuestionnaire["reject"];
    const response = new Promise<WorkbenchUserInputResponse>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const pending: PendingQuestionnaire = {
      cancelReason: null,
      completion: response.then(() => undefined, () => undefined),
      projectId,
      projected: false,
      questionnaire,
      reject,
      reloadReason: null,
      resolve,
      signal,
      status: "waiting",
      stopAbort: null,
      threadId: input.callerThreadId,
    };
    this.pendingByThreadId.set(input.callerThreadId, pending);

    try {
      await this.options.publishPending(input.callerThreadId, questionnaire);
      pending.projected = true;
      if (this.pendingByThreadId.get(input.callerThreadId) === pending && pending.status === "waiting") {
        const onAbort = () => {
          const reason = signal.reason ?? new Error("The questionnaire caller cancelled.");
          if (isWorkbenchAgentMcpRuntimeReloadInterruption(reason)) {
            this.releasePendingForReload(pending, reason);
            return;
          }
          void this.cancelPending(pending, reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.stopAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
    } catch (error) {
      await this.cancelPending(pending, error);
    }

    return await response;
  }

  async respond(input: {
    requestKey: string;
    response: WorkbenchUserInputResponse;
    threadId: string;
  }): Promise<WorkbenchAnsweredQuestionnaire | null> {
    const pending = this.pendingByThreadId.get(input.threadId);
    if (
      !pending
      || !pending.projected
      || pending.status !== "waiting"
      || pending.questionnaire.requestKey !== input.requestKey
    ) {
      return null;
    }

    pending.status = "responding";
    try {
      await this.options.clearPending(input.threadId, input.requestKey);
    } catch (error) {
      if (pending.cancelReason !== null) {
        this.pendingByThreadId.delete(input.threadId);
        pending.stopAbort?.();
        pending.reject(pending.cancelReason);
      } else if (pending.reloadReason !== null) {
        this.pendingByThreadId.delete(input.threadId);
        pending.stopAbort?.();
        pending.reject(pending.reloadReason);
      } else {
        pending.status = "waiting";
      }
      throw error;
    }

    this.pendingByThreadId.delete(input.threadId);
    pending.stopAbort?.();
    const signalCancellation = pending.signal.aborted
      && !isWorkbenchAgentMcpRuntimeReloadInterruption(pending.signal.reason)
      ? pending.signal.reason ?? new Error("The questionnaire caller cancelled.")
      : null;
    const cancellation = pending.cancelReason ?? signalCancellation;
    if (cancellation !== null) {
      pending.reject(cancellation);
      throw cancellation;
    }
    pending.resolve(input.response);
    return {
      ...pending.questionnaire,
      response: input.response,
      threadId: input.threadId,
    };
  }

  private assertActive() {
    if (this.disposed) throw new Error("The questionnaire controller was disposed.");
  }

  private releasePendingForReload(pending: PendingQuestionnaire, error: unknown) {
    if (this.pendingByThreadId.get(pending.threadId) !== pending || pending.status === "cancelling") return;
    pending.reloadReason ??= error;
    if (pending.status === "responding") return;
    this.pendingByThreadId.delete(pending.threadId);
    pending.stopAbort?.();
    pending.stopAbort = null;
    if (pending.status === "waiting") pending.reject(error);
  }

  private async cancelPending(pending: PendingQuestionnaire, error: unknown) {
    if (this.pendingByThreadId.get(pending.threadId) !== pending || pending.status === "cancelling") return;
    if (pending.status === "responding") {
      pending.cancelReason ??= error;
      await pending.completion;
      return;
    }
    pending.status = "cancelling";
    pending.stopAbort?.();
    try {
      await this.options.clearPending(pending.threadId, pending.questionnaire.requestKey);
    } catch {
      this.options.logError?.("Workbench questionnaire cleanup failed.");
    }
    this.pendingByThreadId.delete(pending.threadId);
    pending.reject(error);
  }
}

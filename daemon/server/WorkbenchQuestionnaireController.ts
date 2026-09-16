/*
 * Exports:
 * - WorkbenchQuestionnaireControllerOptions: caller resolution, durable projection, and dismissal ports.
 * - WorkbenchQuestionnaire: durable questionnaire with WB transcript placement.
 * - WorkbenchAnsweredQuestionnaire: consumed WB questionnaire and response.
 * - default WorkbenchQuestionnaireController: own pending questionnaire waits, viability, delivery, correlation, and restart-preserving disposal.
 */
import { randomUUID } from "node:crypto";

import type { WorkbenchDurableQuestionnaire } from "workbench-shared/workbench/thread/thread-state";
import { WORKBENCH_MCP_QUESTIONNAIRE_REQUEST_KEY_PREFIX } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { getQuestionnaireTitle } from "workbench-shared/workbench/thread/thread-questionnaire-transcript";
import type { WorkbenchPendingUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import type { WorkbenchRequestUserInputCommandInput } from "./lib/workbench/commands/questionnaire-command-definition";
import type { WorkbenchThreadId, WorkbenchTurnId, ProjectId } from "workbench-shared/workbench/identity";

export type WorkbenchQuestionnaire = WorkbenchDurableQuestionnaire;

export interface WorkbenchQuestionnaireControllerOptions {
  clearPending(threadId: WorkbenchThreadId, requestKey: string): Promise<void>;
  createRequestKey?: () => string;
  logError?: (message: string) => void;
  publishPending(threadId: WorkbenchThreadId, questionnaire: WorkbenchQuestionnaire): Promise<void>;
  resolveThread(cwd: string, threadId: WorkbenchThreadId): Promise<{
    projectId: ProjectId;
    turnId: WorkbenchTurnId | null;
    pendingQuestionnaire?: WorkbenchQuestionnaire | null;
  }>;
  subscribePending(listener: (state: { projectId: ProjectId; requestKey: string | null; threadId: WorkbenchThreadId }) => void): () => void;
}

export interface WorkbenchAnsweredQuestionnaire extends WorkbenchQuestionnaire {
  response: WorkbenchUserInputResponse;
  threadId: WorkbenchThreadId;
}

type PendingQuestionnaire = {
  cancelReason: unknown | null;
  completion: Promise<void>;
  projectId: ProjectId;
  projected: boolean;
  questionnaire: WorkbenchQuestionnaire;
  reject: (error: unknown) => void;
  releaseReason: unknown | null;
  resolve: (response: WorkbenchUserInputResponse) => void;
  signal: AbortSignal;
  status: "waiting" | "responding" | "cancelling";
  stopAbort: (() => void) | null;
  threadId: WorkbenchThreadId;
};

export default class WorkbenchQuestionnaireController {
  private disposed = false;
  private readonly options: WorkbenchQuestionnaireControllerOptions;
  private readonly pendingByThreadId = new Map<WorkbenchThreadId, PendingQuestionnaire>();
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
    const reason = new Error("The questionnaire controller was disposed.");
    await Promise.all([...this.pendingByThreadId.values()].map(async (pending) => {
      this.releasePending(pending, reason);
      await pending.completion;
    }));
  }

  list() {
    return {
      data: [...this.pendingByThreadId.values()]
        .filter((pending) => pending.projected && pending.status !== "cancelling")
        .map((pending): Omit<WorkbenchPendingUserInputRequest, "harness"> => ({
          itemId: pending.questionnaire.itemId,
          request: pending.questionnaire.request,
          requestKey: pending.questionnaire.requestKey,
          threadId: pending.threadId,
          turnId: pending.questionnaire.turnId,
        })),
    };
  }

  async request(input: Omit<WorkbenchRequestUserInputCommandInput, "callerThreadId"> & { callerThreadId: WorkbenchThreadId }, signal: AbortSignal): Promise<WorkbenchUserInputResponse> {
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
    const questionnaire: WorkbenchQuestionnaire = {
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
      releaseReason: null,
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
      if (this.pendingByThreadId.get(input.callerThreadId) === pending && pending.status === "waiting" && pending.releaseReason === null) {
        const onAbort = () => {
          const reason = signal.reason ?? new Error("The questionnaire caller cancelled.");
          this.releasePending(pending, reason);
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
    threadId: WorkbenchThreadId;
  }): Promise<WorkbenchAnsweredQuestionnaire | null> {
    const pending = this.pendingByThreadId.get(input.threadId);
    if (!pending || !this.canDeliver(input.threadId, input.requestKey)) return null;
    pending.status = "responding";
    try {
      await this.options.clearPending(input.threadId, input.requestKey);
    } catch (error) {
      if (pending.cancelReason !== null) {
        this.pendingByThreadId.delete(input.threadId);
        pending.stopAbort?.();
        pending.reject(pending.cancelReason);
      } else if (pending.releaseReason !== null) {
        this.pendingByThreadId.delete(input.threadId);
        pending.stopAbort?.();
        pending.reject(pending.releaseReason);
      } else {
        pending.status = "waiting";
      }
      throw error;
    }

    return this.finishDelivery(pending, input.response);
  }

  canDeliver(threadId: WorkbenchThreadId, requestKey: string) {
    const pending = this.pendingByThreadId.get(threadId);
    return Boolean(
      pending
      && pending.projected
      && pending.status === "waiting"
      && pending.questionnaire.requestKey === requestKey,
    );
  }

  async deliver(input: {
    requestKey: string;
    response: WorkbenchUserInputResponse;
    threadId: WorkbenchThreadId;
  }): Promise<WorkbenchAnsweredQuestionnaire | null> {
    const pending = this.pendingByThreadId.get(input.threadId);
    if (!pending || !this.canDeliver(input.threadId, input.requestKey)) return null;
    pending.status = "responding";
    return this.finishDelivery(pending, input.response);
  }

  private finishDelivery(pending: PendingQuestionnaire, response: WorkbenchUserInputResponse) {
    this.pendingByThreadId.delete(pending.threadId);
    pending.stopAbort?.();
    const cancellation = pending.cancelReason;
    if (cancellation !== null) {
      pending.reject(cancellation);
      throw cancellation;
    }
    pending.resolve(response);
    return {
      ...pending.questionnaire,
      response,
      threadId: pending.threadId,
    };
  }

  private assertActive() {
    if (this.disposed) throw new Error("The questionnaire controller was disposed.");
  }

  async interruptRetainingQuestionnaire(threadId: WorkbenchThreadId, requestKey: string, interrupt: () => Promise<boolean>) {
    const pending = this.pendingByThreadId.get(threadId);
    if (!pending || pending.questionnaire.requestKey !== requestKey) return interrupt();
    const reason = new Error("The questionnaire wait ended because its turn is being interrupted.");
    pending.releaseReason ??= reason;
    pending.stopAbort?.();
    pending.stopAbort = null;
    try {
      // Let an answer already being saved win, without waking a waiting agent
      // before the provider has processed the interruption.
      if (pending.status === "responding") await pending.completion;
      return await interrupt();
    } finally {
      this.releasePending(pending, reason);
      await pending.completion;
    }
  }

  private releasePending(pending: PendingQuestionnaire, error: unknown) {
    if (this.pendingByThreadId.get(pending.threadId) !== pending || pending.status === "cancelling") return;
    pending.releaseReason ??= error;
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

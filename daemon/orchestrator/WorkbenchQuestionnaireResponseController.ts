/*
 * Exports:
 * - WorkbenchQuestionnaireResponseStatePort: atomic durable questionnaire settlement boundary.
 * - WorkbenchQuestionnaireResponseControllerOptions: questionnaire waiter, harness, and durable-state ports.
 * - default WorkbenchQuestionnaireResponseController: route one answer through live delivery or managed continuation.
 */
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type {
  WorkbenchQuestionnaireRespondRequest,
  WorkbenchQuestionnaireRespondResult,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import {
  NativeThreadIdSchema,
  ProjectIdSchema,
  WorkbenchThreadIdSchema,
  WorkbenchTurnIdSchema,
  type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import {
  getWorkbenchLifecycleTurnId,
  type WorkbenchDurableQuestionnaire,
  type WorkbenchQuestionnaireHistoryEntryState,
  type WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import {
  createWorkbenchQuestionnaireResponseInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import {
  isWorkbenchMcpQuestionnaireRequestKey,
} from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { isWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-user-input-requests";
import type { WorkbenchHarness, WorkbenchUserInputResponse } from "workbench-shared/types";
import type WorkbenchHarnessController from "./WorkbenchHarnessController";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import { WORKBENCH_PROMPT_CONTEXT_FIELD } from "./workbench-prompt-context";

export interface WorkbenchQuestionnaireResponseStatePort {
  resolvePendingQuestionnaire<TDelivery>(
    input: {
      harness: WorkbenchHarness;
      insertAfterItemId?: string | null;
      insertAfterItemIndex?: number | null;
      projectId: ReturnType<typeof ProjectIdSchema.parse>;
      requestKey: string;
      resolvedAt: number;
      response: WorkbenchUserInputResponse;
      threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>;
    },
    deliver: (context: {
      lifecycle: WorkbenchThreadLifecycle;
      questionnaire: WorkbenchDurableQuestionnaire;
    }) => Promise<{
      delivery: TDelivery;
      insertAfterItemId: string | null;
      insertAfterItemIndex: number | null;
      turnId: WorkbenchTurnId;
    }>,
  ): Promise<{ delivery: TDelivery; historyEntry: WorkbenchQuestionnaireHistoryEntryState } | null>;
}

export interface WorkbenchQuestionnaireResponseControllerOptions {
  harnesses: Pick<WorkbenchHarnessController, "request" | "resolvePublicRequest" | "resolveThreadIdentity">;
  questionnaires: Pick<WorkbenchQuestionnaireController, "canDeliver" | "deliver">;
  resolveLatestTurn(input: {
    projectId: ReturnType<typeof ProjectIdSchema.parse>;
    threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>;
  }): Promise<WorkbenchTurnId | null>;
  state: WorkbenchQuestionnaireResponseStatePort;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function warningFrom(response: JsonRpcResponse) {
  const warning = record(response.result)?.warning;
  return typeof warning === "string" && warning.trim() ? warning.slice(0, 500) : undefined;
}

type QuestionnaireDelivery =
  | { route: "admitted" }
  | { route: "live"; warning?: string };

export default class WorkbenchQuestionnaireResponseController {
  constructor(private readonly options: WorkbenchQuestionnaireResponseControllerOptions) {}

  async respond(input: WorkbenchQuestionnaireRespondRequest): Promise<WorkbenchQuestionnaireRespondResult> {
    const workbenchMcp = isWorkbenchMcpQuestionnaireRequestKey(input.requestKey);
    if (workbenchMcp && input.harness !== "codex") {
      throw new Error("Workbench MCP questionnaires require the Codex harness.");
    }

    const projectId = ProjectIdSchema.parse(input.projectId);
    const threadId = WorkbenchThreadIdSchema.parse(input.threadId);
    const nativeThreadId = workbenchMcp ? await this.resolveNativeThreadId(input) : null;
    const resolved = await this.options.state.resolvePendingQuestionnaire<QuestionnaireDelivery>({
      harness: input.harness,
      projectId,
      requestKey: input.requestKey,
      resolvedAt: Date.now(),
      response: input.response,
      threadId,
    }, async ({ lifecycle, questionnaire }) => {
      const approval = isWorkbenchApprovalRequest(questionnaire.request);
      const pendingInput = lifecycle.kind === "needsAttention"
        && lifecycle.reason === "pendingInput"
        && lifecycle.requestKey === input.requestKey;
      const live = pendingInput && (
        !workbenchMcp
        || (nativeThreadId !== null && this.options.questionnaires.canDeliver(nativeThreadId, input.requestKey))
      );
      const settle = <TDelivery>(delivery: TDelivery, acceptedTurnId: WorkbenchTurnId) => ({
        delivery,
        insertAfterItemId: approval ? input.insertAfterItemId ?? questionnaire.itemId : null,
        insertAfterItemIndex: approval ? input.insertAfterItemIndex ?? null : null,
        turnId: acceptedTurnId,
      });
      if (live && workbenchMcp && nativeThreadId) {
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId, questionnaire, lifecycle, approval);
        await this.sendSupplementalInput(input, acceptedTurnId);
        const delivered = await this.options.questionnaires.deliver({
          requestKey: input.requestKey,
          response: input.response,
          threadId: nativeThreadId,
        });
        if (!delivered) throw new Error("The questionnaire waiter detached before delivery.");
        return settle({ route: "live" as const }, acceptedTurnId);
      }
      if (live) {
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId, questionnaire, lifecycle, approval);
        await this.sendSupplementalInput(input, acceptedTurnId);
        const response = await this.sendProviderResponse(input, acceptedTurnId);
        const warning = warningFrom(response);
        return settle({ route: "live" as const, ...(warning ? { warning } : {}) }, acceptedTurnId);
      }
      if (approval) {
        throw new Error("Approval requests cannot be submitted after their owning turn ends.");
      }
      const acceptedTurnId = await this.admitContinuation(input);
      return settle({ route: "admitted" as const }, acceptedTurnId);
    });
    if (!resolved) {
      if (workbenchMcp) throw new Error("That questionnaire is no longer pending.");
      return await this.respondToProvider(input);
    }

    let warning = "warning" in resolved.delivery ? resolved.delivery.warning : undefined;
    if (workbenchMcp) {
      try {
        const historyResponse = await this.sendMapped(input.harness, {
          method: "questionnaire/history/record",
          params: resolved.historyEntry,
        });
        warning = warningFrom(historyResponse);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warning = `Your response was delivered, but transcript history recording failed: ${message.slice(0, 400)}`;
      }
    }
    return {
      ok: true,
      route: resolved.delivery.route,
      ...(warning ? { warning } : {}),
    };
  }

  private async respondToProvider(input: WorkbenchQuestionnaireRespondRequest): Promise<WorkbenchQuestionnaireRespondResult> {
    await this.sendSupplementalInput(input, input.turnId ?? null);
    const response = await this.sendProviderResponse(input, input.turnId ?? null);
    const warning = warningFrom(response);
    return { ok: true, route: "provider", ...(warning ? { warning } : {}) };
  }

  private async sendProviderResponse(input: WorkbenchQuestionnaireRespondRequest, turnId: string | null) {
    return await this.sendMapped(input.harness, {
      method: "questionnaire/respond",
      params: {
        insertAfterItemId: input.insertAfterItemId ?? null,
        insertAfterItemIndex: input.insertAfterItemIndex ?? null,
        requestKey: input.requestKey,
        response: input.response,
        threadId: input.threadId,
        turnId,
      },
    });
  }

  private async resolveNativeThreadId(input: WorkbenchQuestionnaireRespondRequest) {
    const mapped = await this.options.harnesses.resolvePublicRequest(input.harness, {
      method: "thread/read",
      params: { projectId: input.projectId, threadId: input.threadId },
    });
    const threadId = record(mapped.request.params)?.threadId;
    return NativeThreadIdSchema.parse(threadId);
  }

  private async sendSupplementalInput(input: WorkbenchQuestionnaireRespondRequest, turnId: string | null) {
    const activatedSkillPaths = input.harness === "codex"
      ? Array.from(new Set(input.activatedSkillPaths?.map(path => path.trim()).filter(Boolean) ?? []))
      : [];
    const supplementalInput = input.supplementalInput ?? [];
    if (!supplementalInput.length && !activatedSkillPaths.length) return;
    if (!turnId) throw new Error("Questionnaire supplemental input requires an owning turn.");
    await this.sendMapped(input.harness, {
      method: "turn/steer",
      ...(activatedSkillPaths.length ? {
        [WORKBENCH_PROMPT_CONTEXT_FIELD]: { activatedSkillPaths },
      } : {}),
      params: {
        expectedTurnId: turnId,
        input: supplementalInput,
        threadId: input.threadId,
      },
    });
  }

  private async resolveLiveTurn(
    projectId: ReturnType<typeof ProjectIdSchema.parse>,
    threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>,
    questionnaire: WorkbenchDurableQuestionnaire,
    lifecycle: WorkbenchThreadLifecycle,
    approval: boolean,
  ) {
    if (approval) {
      const turnId = questionnaire.turnId ?? getWorkbenchLifecycleTurnId(lifecycle);
      if (!turnId) throw new Error("The approval request has no active owning turn.");
      return turnId;
    }
    const turnId = await this.options.resolveLatestTurn({ projectId, threadId });
    if (!turnId) throw new Error("The questionnaire thread has no history point for its response.");
    return turnId;
  }

  private readAcceptedTurnId(response: JsonRpcResponse) {
    const result = record(response.result);
    const turn = record(result?.turn);
    const turnId = typeof result?.turnId === "string"
      ? result.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : null;
    if (!turnId) throw new Error("Questionnaire continuation admission returned no accepted turn.");
    return WorkbenchTurnIdSchema.parse(turnId);
  }

  private async admitContinuation(input: WorkbenchQuestionnaireRespondRequest) {
    const activatedSkillPaths = Array.from(new Set(
      input.activatedSkillPaths?.map(path => path.trim()).filter(Boolean) ?? [],
    ));
    const promptContext = activatedSkillPaths.length ? {
      [WORKBENCH_PROMPT_CONTEXT_FIELD]: { activatedSkillPaths },
    } : {};
    const turnInput = [
      ...createWorkbenchQuestionnaireResponseInput(input.response),
      ...(input.supplementalInput ?? []),
    ];
    if (input.harness !== "codex") {
      const identity = await this.options.harnesses.resolveThreadIdentity({
        harness: input.harness,
        projectId: ProjectIdSchema.parse(input.projectId),
        threadId: WorkbenchThreadIdSchema.parse(input.threadId),
      });
      const binding = identity?.bindings.find(binding => binding.harness === input.harness);
      if (!binding) throw new Error("The questionnaire thread has no native provider binding.");
      const response = await this.sendMapped(input.harness, {
        method: "turn/start",
        ...(input.harness === "opencode" ? {
          [WORKBENCH_PROMPT_CONTEXT_FIELD]: {
            cwd: binding.nativeLocation,
            projectId: input.projectId,
            threadId: input.threadId,
          },
        } : {}),
        params: {
          cwd: binding.nativeLocation,
          input: turnInput,
          ...(input.harness === "copilot" ? { projectId: input.projectId } : {}),
          threadId: input.threadId,
        },
      });
      return this.readAcceptedTurnId(response);
    }
    const response = await this.sendMapped("codex", {
      method: "workbench/codex/message/admit",
      params: {
        resumeRequest: {
          method: "thread/resume",
          params: { excludeTurns: true, threadId: input.threadId },
        },
        startRequest: {
          method: "turn/start",
          ...promptContext,
          params: {
            clientUserMessageId: input.requestKey,
            input: turnInput,
            threadId: input.threadId,
          },
        },
        steerRequest: {
          method: "turn/steer",
          ...promptContext,
          params: { input: turnInput },
        },
        threadId: input.threadId,
      },
    });
    return this.readAcceptedTurnId(response);
  }

  private async sendMapped(harness: WorkbenchHarness, request: JsonRpcRequest) {
    const mapped = await this.options.harnesses.resolvePublicRequest(harness, request);
    const response = await this.options.harnesses.request(mapped.harness, mapped.request);
    if (response.error) throw new Error(response.error.message);
    return response;
  }
}

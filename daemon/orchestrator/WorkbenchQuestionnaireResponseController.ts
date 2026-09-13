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
} from "workbench-shared/workbench/identity";
import {
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
      historyEntry: WorkbenchQuestionnaireHistoryEntryState;
      lifecycle: WorkbenchThreadLifecycle;
      questionnaire: WorkbenchDurableQuestionnaire;
    }) => Promise<TDelivery>,
  ): Promise<{ delivery: TDelivery; historyEntry: WorkbenchQuestionnaireHistoryEntryState } | null>;
}

export interface WorkbenchQuestionnaireResponseControllerOptions {
  harnesses: Pick<WorkbenchHarnessController, "request" | "resolvePublicRequest" | "resolveThreadIdentity">;
  questionnaires: Pick<WorkbenchQuestionnaireController, "canDeliver" | "deliver">;
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
    const resolved = await this.options.state.resolvePendingQuestionnaire({
      harness: input.harness,
      insertAfterItemId: input.insertAfterItemId,
      insertAfterItemIndex: input.insertAfterItemIndex,
      projectId,
      requestKey: input.requestKey,
      resolvedAt: Date.now(),
      response: input.response,
      threadId,
    }, async ({ historyEntry, lifecycle, questionnaire }) => {
      const pendingInput = lifecycle.kind === "needsAttention"
        && lifecycle.reason === "pendingInput"
        && lifecycle.requestKey === input.requestKey;
      const live = pendingInput && (
        !workbenchMcp
        || (nativeThreadId !== null && this.options.questionnaires.canDeliver(nativeThreadId, input.requestKey))
      );
      if (live && workbenchMcp && nativeThreadId) {
        await this.sendSupplementalInput(input, historyEntry.turnId);
        const delivered = await this.options.questionnaires.deliver({
          requestKey: input.requestKey,
          response: input.response,
          threadId: nativeThreadId,
        });
        if (!delivered) throw new Error("The questionnaire waiter detached before delivery.");
        return { route: "live" as const };
      }
      if (live) {
        await this.sendSupplementalInput(input, historyEntry.turnId);
        const response = await this.sendProviderResponse(input, historyEntry.turnId);
        const warning = warningFrom(response);
        return { route: "live" as const, ...(warning ? { warning } : {}) };
      }
      if (isWorkbenchApprovalRequest(questionnaire.request)) {
        throw new Error("Approval requests cannot be submitted after their owning turn ends.");
      }
      await this.admitContinuation(input);
      return { route: "admitted" as const };
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
      await this.sendMapped(input.harness, {
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
      return;
    }
    await this.sendMapped("codex", {
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
  }

  private async sendMapped(harness: WorkbenchHarness, request: JsonRpcRequest) {
    const mapped = await this.options.harnesses.resolvePublicRequest(harness, request);
    const response = await this.options.harnesses.request(mapped.harness, mapped.request);
    if (response.error) throw new Error(response.error.message);
    return response;
  }
}

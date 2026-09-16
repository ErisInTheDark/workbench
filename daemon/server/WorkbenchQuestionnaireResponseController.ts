/*
 * Exports:
 * - WorkbenchQuestionnaireResponseStatePort: atomic durable questionnaire settlement boundary.
 * - WorkbenchQuestionnaireResponseControllerOptions: questionnaire waiter, harness, and durable-state ports.
 * - default WorkbenchQuestionnaireResponseController: route one answer through live delivery or managed continuation.
 */
import type {
  WorkbenchQuestionnaireRespondRequest,
  WorkbenchQuestionnaireRespondResult,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import {
  ProjectIdSchema,
  WorkbenchTurnIdSchema,
  WorkbenchThreadIdSchema,
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
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";

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
  harnesses: Pick<WorkbenchHarnessController, "resolveThreadIdentity">;
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  resolveLatestTurn(input: {
    projectId: ReturnType<typeof ProjectIdSchema.parse>;
    threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>;
  }): Promise<WorkbenchTurnId | null>;
  state: WorkbenchQuestionnaireResponseStatePort;
}

type QuestionnaireDelivery =
  | { route: "admitted"; warning?: string }
  | { route: "live"; warning?: string };
type ResolvedQuestionnaireRequest = WorkbenchQuestionnaireRespondRequest & { harness: WorkbenchHarness };

export default class WorkbenchQuestionnaireResponseController {
  constructor(private readonly options: WorkbenchQuestionnaireResponseControllerOptions) {}

  private provider(harness: WorkbenchHarness) {
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!key) throw new Error("The questionnaire provider is unavailable.");
    return this.options.providers.get(key);
  }

  private interactions(harness: WorkbenchHarness) {
    const interactions = this.provider(harness).interactions;
    if (!interactions) throw new Error("This provider does not support interactive requests.");
    return interactions;
  }

  async respond(request: WorkbenchQuestionnaireRespondRequest): Promise<WorkbenchQuestionnaireRespondResult> {
    const identity = await this.options.harnesses.resolveThreadIdentity({
      threadId: WorkbenchThreadIdSchema.parse(request.threadId),
      projectId: ProjectIdSchema.parse(request.projectId),
    });
    const binding = identity?.bindings[0];
    if (!identity || !binding) throw new Error("The questionnaire thread has no provider binding.");
    const input = { ...request, harness: binding.harness, threadId: identity.threadId, projectId: identity.projectId };
    const workbenchMcp = isWorkbenchMcpQuestionnaireRequestKey(input.requestKey);

    const projectId = ProjectIdSchema.parse(input.projectId);
    const threadId = WorkbenchThreadIdSchema.parse(input.threadId);
    const interactions = this.interactions(input.harness);
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
        || await interactions.canDeliver(threadId, input.requestKey)
      );
      const settle = <TDelivery>(delivery: TDelivery, acceptedTurnId: WorkbenchTurnId) => ({
        delivery,
        insertAfterItemId: approval ? input.insertAfterItemId ?? questionnaire.itemId : null,
        insertAfterItemIndex: approval ? input.insertAfterItemIndex ?? null : null,
        turnId: acceptedTurnId,
      });
      if (live && workbenchMcp) {
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId, questionnaire, lifecycle, approval);
        await this.sendSupplementalInput(input, acceptedTurnId);
        const delivered = await interactions.deliver({
          requestKey: input.requestKey,
          response: input.response,
          threadId,
        });
        if (!delivered) throw new Error("The questionnaire waiter detached before delivery.");
        return settle({ route: "live" as const }, acceptedTurnId);
      }
      if (live) {
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId, questionnaire, lifecycle, approval);
        await this.sendSupplementalInput(input, acceptedTurnId);
        const response = await this.sendProviderResponse(input, acceptedTurnId);
        const warning = response.warning;
        return settle({ route: "live" as const, ...(warning ? { warning } : {}) }, acceptedTurnId);
      }
      if (approval) {
        throw new Error("Approval requests cannot be submitted after their owning turn ends.");
      }
      const accepted = await this.admitContinuation(input);
      return settle({ route: "admitted" as const, ...(accepted.warning ? { warning: accepted.warning } : {}) }, accepted.turnId);
    });
    if (!resolved) {
      if (workbenchMcp) throw new Error("That questionnaire is no longer pending.");
      return await this.respondToProvider(input);
    }

    let warning = "warning" in resolved.delivery ? resolved.delivery.warning : undefined;
    if (workbenchMcp) {
      try {
        const historyResponse = await interactions.record(resolved.historyEntry);
        warning = historyResponse.warning ?? warning;
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

  private async respondToProvider(input: ResolvedQuestionnaireRequest): Promise<WorkbenchQuestionnaireRespondResult> {
    await this.sendSupplementalInput(input, input.turnId ?? null);
    const response = await this.sendProviderResponse(input, input.turnId ?? null);
    const warning = response.warning;
    return { ok: true, route: "provider", ...(warning ? { warning } : {}) };
  }

  private async sendProviderResponse(input: ResolvedQuestionnaireRequest, turnId: string | null) {
    return await this.interactions(input.harness).respond({
        insertAfterItemId: input.insertAfterItemId ?? null,
        insertAfterItemIndex: input.insertAfterItemIndex ?? null,
        requestKey: input.requestKey,
        response: input.response,
        threadId: input.threadId,
        turnId,
    });
  }

  private async sendSupplementalInput(input: ResolvedQuestionnaireRequest, turnId: string | null) {
    const activatedSkillPaths = Array.from(new Set(input.activatedSkillPaths?.map(path => path.trim()).filter(Boolean) ?? []));
    const supplementalInput = input.supplementalInput ?? [];
    if (!supplementalInput.length && !activatedSkillPaths.length) return;
    if (!turnId) throw new Error("Questionnaire supplemental input requires an owning turn.");
    await this.interactions(input.harness).supplement({
        turnId,
        input: supplementalInput,
        threadId: input.threadId,
        activatedSkillPaths,
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

  private async admitContinuation(input: ResolvedQuestionnaireRequest) {
    const activatedSkillPaths = Array.from(new Set(
      input.activatedSkillPaths?.map(path => path.trim()).filter(Boolean) ?? [],
    ));
    const turnInput = [
      ...createWorkbenchQuestionnaireResponseInput(input.response),
      ...(input.supplementalInput ?? []),
    ];
    const result = await this.provider(input.harness).threads.submit({
      intent: "continue",
      clientMessageId: input.requestKey,
      threadId: input.threadId,
      input: turnInput,
      ...(activatedSkillPaths.length ? { context: { activatedSkillPaths } } : {}),
    });
    return {
      turnId: WorkbenchTurnIdSchema.parse(result.kind === "started" ? result.turn.id : result.turnId),
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }
}

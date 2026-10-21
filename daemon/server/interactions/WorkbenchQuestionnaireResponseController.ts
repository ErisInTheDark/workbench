/*
 * Exports:
 * - WorkbenchQuestionnaireResponseStatePort: atomic durable questionnaire settlement boundary.
 * - WorkbenchQuestionnaireResponseControllerOptions: approval owner, questionnaire waiter, harness, virtual-steer, and durable-state ports.
 * - default WorkbenchQuestionnaireResponseController: route one answer to its live approval, live delivery, or managed continuation (carrying virtual steers), recording skills it activates.
 */
import type {
  WorkbenchQuestionnaireRespondRequest,
  WorkbenchQuestionnaireRespondResult,
} from "workbench-shared/workbench/daemon/workbench-daemon-requests";
import {
  ProjectIdSchema,
  WorkbenchTurnIdSchema,
  WorkbenchThreadIdSchema,
  type WorkbenchThreadId,
  type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type {
  WorkbenchDurableQuestionnaire,
  WorkbenchQuestionnaireHistoryEntryState,
  WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";
import {
  createWorkbenchQuestionnaireResponseInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import {
  isWorkbenchMcpQuestionnaireRequestKey,
} from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import type { WorkbenchHarness, WorkbenchSkillSummary, WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";
import { collectActivatedSkillPaths } from "workbench-shared/workbench/thread/thread-skill-state";
import { assertWorkbenchSkillActivations } from "workbench-shared/workbench/thread/thread-skill-mentions";
import { joinUserInputs } from "./WorkbenchQuestionnaireSteerController";
import type WorkbenchQuestionnaireSteerController from "./WorkbenchQuestionnaireSteerController";
import type WorkbenchApprovalController from "./WorkbenchApprovalController";
import type WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
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
  approvals: Pick<WorkbenchApprovalController, "owns" | "list" | "respond">;
  harnesses: Pick<WorkbenchHarnessController, "resolveThreadIdentity">;
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  resolveLatestTurn(input: {
    projectId: ReturnType<typeof ProjectIdSchema.parse>;
    threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>;
  }): Promise<WorkbenchTurnId | null>;
  state: WorkbenchQuestionnaireResponseStatePort;
  /** Virtual steers ride along with a continuation and retire once it is accepted. */
  questionnaireSteers: Pick<WorkbenchQuestionnaireSteerController, "deliverWith">;
  /** Skills the thread can activate; claimed answer activations are checked against them. */
  readSkills(threadId: WorkbenchThreadId): Promise<readonly WorkbenchSkillSummary[]>;
  /** Record skills an accepted answer activated; failure never undoes the answer. */
  recordSkillActivations?(threadId: string, paths: readonly string[]): Promise<void>;
}

/** Answers the user typed: those that are not one of their question's option labels. */
function freeTextAnswers(request: WorkbenchUserInputRequest, response: WorkbenchUserInputResponse) {
  return Object.entries(response.answers).flatMap(([questionId, { answers }]) => {
    const labels = new Set(request.questions.find(question => question.id === questionId)?.options?.map(option => option.label));
    return answers.filter(answer => !labels.has(answer));
  });
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
    if (this.options.approvals.owns(threadId, input.requestKey)) {
      await this.checkSkillActivations(input, this.options.approvals.list()
        .find(candidate => candidate.threadId === threadId && candidate.requestKey === input.requestKey)?.request);
      await this.sendSupplementalInput(input, input.turnId ?? null);
      await this.options.approvals.respond({ threadId, requestKey: input.requestKey, response: input.response });
      return { ok: true, route: "live" };
    }
    const interactions = this.interactions(input.harness);
    const resolved = await this.options.state.resolvePendingQuestionnaire<QuestionnaireDelivery>({
      harness: input.harness,
      projectId,
      requestKey: input.requestKey,
      resolvedAt: Date.now(),
      response: input.response,
      threadId,
    }, async ({ lifecycle, questionnaire }) => {
      await this.checkSkillActivations(input, questionnaire.request);
      const pendingInput = lifecycle.kind === "needsAttention"
        && lifecycle.reason === "pendingInput"
        && lifecycle.requestKey === input.requestKey;
      const liveLifecycle = pendingInput
        || lifecycle.kind === "completed"
        || (lifecycle.kind === "needsAttention" && lifecycle.reason === "agentBlocked");
      const live = liveLifecycle && await interactions.canDeliver(threadId, input.requestKey);
      const settle = <TDelivery>(delivery: TDelivery, acceptedTurnId: WorkbenchTurnId) => ({
        delivery,
        insertAfterItemId: null,
        insertAfterItemIndex: null,
        turnId: acceptedTurnId,
      });
      if (live && workbenchMcp) {
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId);
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
        const acceptedTurnId = await this.resolveLiveTurn(projectId, threadId);
        await this.sendSupplementalInput(input, acceptedTurnId);
        const response = await this.sendProviderResponse(input, acceptedTurnId);
        const warning = response.warning;
        return settle({ route: "live" as const, ...(warning ? { warning } : {}) }, acceptedTurnId);
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
    const pending = await this.interactions(input.harness).pending();
    await this.checkSkillActivations(input, pending
      .find(candidate => candidate.threadId === input.threadId && candidate.requestKey === input.requestKey)?.request);
    await this.sendSupplementalInput(input, input.turnId ?? null);
    const response = await this.sendProviderResponse(input, input.turnId ?? null);
    const warning = response.warning;
    return { ok: true, route: "provider", ...(warning ? { warning } : {}) };
  }

  /** Claimed activations must match the skills the typed answers name; an unknown request leaves every answer typed. */
  private async checkSkillActivations(input: ResolvedQuestionnaireRequest, request: WorkbenchUserInputRequest | undefined) {
    if (!input.activatedSkillPaths) return;
    const texts = request
      ? freeTextAnswers(request, input.response)
      : Object.values(input.response.answers).flatMap(({ answers }) => answers);
    assertWorkbenchSkillActivations(input.activatedSkillPaths, texts,
      await this.options.readSkills(WorkbenchThreadIdSchema.parse(input.threadId)));
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
    await this.recordSkillActivations(input.threadId, collectActivatedSkillPaths(supplementalInput, { activatedSkillPaths }));
  }

  private async recordSkillActivations(threadId: string, paths: readonly string[]) {
    try {
      await this.options.recordSkillActivations?.(threadId, paths);
    } catch (error) {
      console.warn("[questionnaire] activated skills were not recorded",
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure");
    }
  }

  private async resolveLiveTurn(
    projectId: ReturnType<typeof ProjectIdSchema.parse>,
    threadId: ReturnType<typeof WorkbenchThreadIdSchema.parse>,
  ) {
    const turnId = await this.options.resolveLatestTurn({ projectId, threadId });
    if (!turnId) throw new Error("The questionnaire thread has no history point for its response.");
    return turnId;
  }

  /**
   * The answer opens the new turn as one message: `<answer>\n\n<extra input>\n\n<steer 1>\n\n<steer 2>`.
   * Admission activates and records the skills it names; the answer's checked activations ride along as context.
   */
  private async admitContinuation(input: ResolvedQuestionnaireRequest) {
    const activatedSkillPaths = Array.from(new Set(
      input.activatedSkillPaths?.map(path => path.trim()).filter(Boolean) ?? [],
    ));
    const result = await this.options.questionnaireSteers.deliverWith(input.threadId, steers => (
      this.provider(input.harness).threads.submit({
        intent: "continue",
        clientMessageId: input.requestKey,
        threadId: input.threadId,
        input: joinUserInputs([createWorkbenchQuestionnaireResponseInput(input.response), input.supplementalInput ?? [], ...steers]),
        ...(activatedSkillPaths.length ? { context: { activatedSkillPaths } } : {}),
        ...(input.skipAutoCompact ? { skipAutoCompact: true } : {}),
      })
    ));
    return {
      turnId: WorkbenchTurnIdSchema.parse(result.kind === "started" ? result.turn.id : result.turnId),
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }
}

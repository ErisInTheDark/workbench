/*
 * Exports:
 * - WorkbenchThreadActionOwners: shared identity, profile/state, project and transcript owners.
 * - WorkbenchThreadCreationNotDispatchedError: definite validation failure before provider creation.
 * - default WorkbenchThreadActionController: own WB actions, full thread stop, user shell stops, orphan repair, skills, goals, todos, addressed feedback, questionnaire snooze and steer redelivery.
 */
import { randomUUID } from "node:crypto";
import type { ThreadPayload, WorkbenchHarness } from "workbench-shared/types";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import { WorkbenchUserInputSchema } from "workbench-shared/workbench/provider/provider-input";
import {
  workbenchThreadActions, type WorkbenchThreadActionMap, type WorkbenchThreadCreate,
  type WorkbenchThreadMessage, type WorkbenchThreadShellTarget, type WorkbenchThreadSteerTarget, type WorkbenchThreadStop,
} from "workbench-shared/workbench/thread/thread-actions";
import {
  ThreadReferenceSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema, type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import type { DaemonTranscriptRegistration } from "./daemon-runtime-objects";
import type { WorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import type WorkbenchTurnSettlementController from "./WorkbenchTurnSettlementController";
import type { WorkbenchThreadLaunchLocation } from "workbench-shared/workbench/thread/thread-launch";
import type WorkbenchApprovalController from "./WorkbenchApprovalController";
import type WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchThreadStateFeature from "./WorkbenchThreadStateFeature";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchTranscriptReader from "./WorkbenchTranscriptReader";
import type WorkbenchTranscriptReconciliationController from "./WorkbenchTranscriptReconciliationController";
import type WorkbenchThreadSkillsController from "./WorkbenchThreadSkillsController";
import type WorkbenchThreadGoalController from "./WorkbenchThreadGoalController";
import type WorkbenchThreadTodoController from "./WorkbenchThreadTodoController";
import type WorkbenchThreadAddressedFeedbackController from "./WorkbenchThreadAddressedFeedbackController";
import type WorkbenchThreadAutoCompactController from "./WorkbenchThreadAutoCompactController";
import type WorkbenchThreadCompactionController from "./WorkbenchThreadCompactionController";
import { collectActivatedSkillPaths } from "workbench-shared/workbench/thread/thread-skill-state";
import { readWorkbenchAgentMessageInput } from "workbench-shared/workbench/thread/thread-agent-message";

export interface WorkbenchThreadActionOwners {
  autoCompact: Pick<WorkbenchThreadAutoCompactController, "observe">;
  compaction: Pick<WorkbenchThreadCompactionController, "compact">;
  approvals: Pick<WorkbenchApprovalController, "list">;
  reconciliation: Pick<WorkbenchTranscriptReconciliationController, "reconcile">;
  transcripts: Pick<WorkbenchTranscriptReader, "readPage" | "history">;
  /** Canonical transcript writes for Workbench-owned steer decisions, and item source reads for shell stops. */
  transcript: Pick<DaemonTranscriptRegistration, "record" | "read">;
  /** Running wb shell calls the user can stop. */
  shells: Pick<WorkbenchAgentMcpRequestRegistry, "stopShell">;
  /** Settles a stopped turn whose runtime is already gone. */
  settlement: Pick<WorkbenchTurnSettlementController, "settleIfOrphaned">;
  providers: Pick<WorkbenchProviderDispatcher, "get">;
  projects: Pick<WorkbenchProjectCatalogController, "resolveProjectById">;
  identities: Pick<WorkbenchThreadIdentityController, "resolve" | "resolveTurn">;
  profiles: Pick<WorkbenchThreadStateFeature, "captureCreationProfile" | "captureCreationProfileForProject">;
  state: Pick<
    WorkbenchThreadStateController,
    "getCanonicalThreadEntry" | "handleRequest" | "listPendingQuestionnaires"
  >;
  skills: Pick<WorkbenchThreadSkillsController, "read" | "deactivate">;
  goals: Pick<WorkbenchThreadGoalController, "set" | "clear">;
  todos: Pick<WorkbenchThreadTodoController, "add" | "remove" | "setRequired" | "setText">;
  addressedFeedback: Pick<WorkbenchThreadAddressedFeedbackController, "clear">;
  vis: Pick<import("./vis/WorkbenchVisController").default, "answer" | "endById">;
  /** Record skills an accepted submission activated. */
  recordSkillActivations(threadId: string, paths: readonly string[]): Promise<void>;
  warn(message: string): void;
}

type ActionTarget = Awaited<ReturnType<WorkbenchThreadActionController["target"]>>;

function stateTarget({ identity, harness }: ActionTarget) {
  return { projectId: identity.projectId, identity: { harness, threadId: identity.threadId } };
}

/** A history read reports its turns only when it covered just those turns. */
function historyScope({ scopedTurnIds }: { scopedTurnIds?: readonly string[] }) {
  return scopedTurnIds ? { turnIds: [...scopedTurnIds] } : {};
}

type Actions = {
  [Method in keyof WorkbenchThreadActionMap]: (
    input: WorkbenchThreadActionMap[Method]["params"],
    connectionId?: string,
  ) => Promise<WorkbenchThreadActionMap[Method]["result"]>;
};

export class WorkbenchThreadCreationNotDispatchedError extends Error {}

export default class WorkbenchThreadActionController {
  /** Per-thread redelivery chain, so overlapping turn starts never send one stranded message twice. */
  private readonly redeliveries = new Map<string, Promise<void>>();

  constructor(private readonly owners: WorkbenchThreadActionOwners) {}

  async materialize(threadId: string, turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    for (const turnId of turnIds) {
      await this.owners.reconciliation.reconcile({
        threadId, target: { mode: "exact", turnId }, refresh: false,
      }, signal);
    }
  }

  private provider(harness: WorkbenchHarness) {
    const key = installedProviderKeys.find(candidate => candidate === harness);
    if (!key) throw new Error(`Provider ${harness} is not installed.`);
    return this.owners.providers.get(key);
  }

  private async target(reference: string) {
    const identity = await this.owners.identities.resolve({ threadId: ThreadReferenceSchema.parse(reference) });
    if (!identity) {
      const threadId = reference.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 160);
      throw new Error(`The requested thread has no durable Workbench identity. threadId=${threadId}`);
    }
    const binding = identity.bindings[0];
    if (!binding) throw new Error("The requested thread has no provider binding.");
    return { identity, harness: binding.harness, provider: this.provider(binding.harness) };
  }

  private readonly actions: Actions = {
    "questionnaires/pending/read": async () => {
      const providerPending = (await Promise.all(installedProviderKeys.map(
        key => this.owners.providers.get(key).interactions?.pending() ?? [],
      ))).flat();
      const data = [...this.owners.state.listPendingQuestionnaires()];
      for (const request of [...this.owners.approvals.list(), ...providerPending]) {
        if (!data.some(candidate =>
          candidate.harness === request.harness
          && candidate.threadId === request.threadId
          && candidate.requestKey === request.requestKey)) {
          data.push(request);
        }
      }
      return { data };
    },
    "thread/questionnaires/read": async input => {
      const history = await this.owners.transcripts.history(input.threadId, input.turnIds);
      return { data: history.questionnaireEntries, ...historyScope(history) };
    },
    "thread/steers/read": async input => {
      const history = await this.owners.transcripts.history(input.threadId, input.turnIds);
      return { data: history.steerEntries, ...historyScope(history) };
    },
    "thread/browse/read": async input => {
      const history = await this.owners.transcripts.history(input.threadId, input.turnIds);
      return { data: history.browseResultEntries, ...historyScope(history) };
    },
    "thread/approvals/read": async input => {
      const history = await this.owners.transcripts.history(input.threadId, input.turnIds);
      return { data: history.approvalEntries, ...historyScope(history) };
    },
    "thread/create": input => this.create(input),
    "thread/message/submit": input => this.message(input),
    "thread/metadata/read": async input => {
      const target = await this.target(input.threadId);
      return this.withAutoCompactStatus(await target.provider.threads.read(target.identity.threadId));
    },
    "thread/page/read": async input => {
      const page = await this.owners.transcripts.readPage(input);
      return { ...page, thread: await this.withAutoCompactStatus(page.thread) };
    },
    "thread/reconcile": async input => {
      return this.owners.reconciliation.reconcile(input);
    },
    "thread/title/set": async (input, connectionId) => {
      const target = await this.target(input.threadId);
      if (!connectionId) throw new Error("Thread title changes require the observing connection.");
      const response = await this.owners.state.handleRequest(connectionId, {
        method: "workbench/thread-state/title/set",
        projectId: target.identity.projectId,
        identity: { harness: target.harness, threadId: target.identity.threadId },
        title: input.title,
      });
      if ("error" in response) throw new Error(response.error.message);
      return { ok: true };
    },
    "thread/compact": async input => {
      const target = await this.target(input.threadId);
      await this.owners.compaction.compact(target.identity.threadId, target.provider);
      return { ok: true };
    },
    "thread/provider/delete": async input => {
      const target = await this.target(input.threadId);
      if (target.identity.bindings.length !== 1) throw new Error("Provider deletion requires one unambiguous thread binding.");
      if (!target.provider.threads.delete) throw new Error("This provider does not support deleting its threads.");
      await target.provider.threads.delete(target.identity.threadId);
      return { ok: true };
    },
    "thread/stop": (input, connectionId) => this.stop(input, connectionId),
    "thread/interrupt": async (input, connectionId) => {
      await this.snoozeQuestionnaire(await this.target(input.threadId), input.requestKey, connectionId ?? "");
      return { ok: true };
    },
    "thread/goal/set": async input => ({ goal: await this.owners.goals.set(input.threadId, input.objective) }),
    "thread/goal/clear": async input => {
      await this.owners.goals.clear(input.threadId);
      return { ok: true };
    },
    "thread/todo/add": async input => ({ todo: await this.owners.todos.add(input.threadId, input.text, input.required) }),
    "thread/todo/remove": async input => {
      await this.owners.todos.remove(input.threadId, [input.id]);
      return { ok: true };
    },
    "thread/todo/required/set": async input => {
      await this.owners.todos.setRequired(input.threadId, input.id, input.required);
      return { ok: true };
    },
    "thread/todo/text/set": async input => {
      await this.owners.todos.setText(input.threadId, input.id, input.text);
      return { ok: true };
    },
    "thread/feedback/addressed/clear": async input => {
      await this.owners.addressedFeedback.clear(input.threadId);
      return { ok: true };
    },
    "thread/vis/end": async input => {
      await this.owners.vis.endById(input.threadId, input.sessionId);
      return { ok: true };
    },
    "thread/vis/answer": async input => {
      await this.owners.vis.answer(input.threadId, input.sessionId, input.value);
      return { ok: true };
    },
    "thread/skills/read": async input => ({ skills: await this.owners.skills.read(input.threadId) }),
    "thread/skills/deactivate": async input => ({ skills: await this.owners.skills.deactivate(input.threadId, input.path) }),
    "thread/steer/resend": input => this.resendSteer(input),
    "thread/steer/dismiss": input => this.dismissSteer(input),
    "thread/shell/stop": input => this.stopShell(input),
  };

  async handle<Method extends keyof WorkbenchThreadActionMap>(method: Method, params: object, connectionId?: string) {
    const input = workbenchThreadActions[method].params.parse(params) as WorkbenchThreadActionMap[Method]["params"];
    return this.actions[method](input, connectionId);
  }

  async createForLaunch(input: WorkbenchThreadCreate, launchId: string,
    location: WorkbenchThreadLaunchLocation) {
    return this.create(input, launchId, location);
  }

  private async create(input: WorkbenchThreadCreate, launchId?: string,
    location?: WorkbenchThreadLaunchLocation) {
    let prepared: {
      project: Awaited<ReturnType<WorkbenchProjectCatalogController["resolveProjectById"]>>;
      captured: Awaited<ReturnType<WorkbenchThreadStateFeature["captureCreationProfileForProject"]>>;
      provider: ReturnType<WorkbenchThreadActionController["provider"]>;
    };
    try {
      const project = await this.owners.projects.resolveProjectById(input.projectId);
      const captured = await this.owners.profiles.captureCreationProfileForProject(undefined, project, input.profile);
      if (location && (project.rootPath !== location.rootPath || captured.cwd !== location.rootPath
        || project.roots.length !== location.roots.length
        || project.roots.some((root, index) => root.rootPath !== location.roots[index]))) {
        throw new Error("Captured launch location changed before provider creation.");
      }
      prepared = { project, captured, provider: this.provider(captured.selection.settings.harness) };
    } catch (error) {
      if (!launchId) throw error;
      throw new WorkbenchThreadCreationNotDispatchedError(
        error instanceof Error ? error.message : "Thread creation could not be prepared.", { cause: error });
    }
    const { project, captured, provider } = prepared;
    return provider.threads.create({
      cwd: location?.rootPath ?? captured.cwd, profile: captured.selection,
      ...(input.context ? { context: input.context } : {}),
      projectLocation: { id: project.id, rootPath: project.rootPath, ...(launchId ? { launchId } : {}) },
      projectRoots: location?.roots ?? project.roots.map(root => root.rootPath),
      additionalWritableRoots: input.additionalWritableRoots,
    });
  }

  private async message(input: WorkbenchThreadMessage) {
    const { identity, harness, provider } = await this.target(input.threadId);
    const providerInput = input.intent === "newTurn"
      ? { ...input, threadId: identity.threadId }
      : {
          threadId: identity.threadId,
          clientMessageId: input.clientMessageId,
          input: input.input,
          ...(input.context ? { context: input.context } : {}),
          ...(input.skipAutoCompact ? { skipAutoCompact: true } : {}),
          intent: "continue" as const,
        };
    const result = await provider.threads.submit(providerInput);
    const warnings: string[] = [];
    try {
      await this.owners.recordSkillActivations(identity.threadId, collectActivatedSkillPaths(input.input, input.context));
    } catch (error) {
      const warning = "Your message was accepted, but Workbench could not record its activated skills.";
      this.owners.warn(`${warning} ${error instanceof Error ? error.message.slice(0, 300) : ""}`);
      warnings.push(warning);
    }
    return warnings.length
      ? { ...result, warning: [result.warning?.slice(0, 500), ...warnings].filter(Boolean).join(" ") }
      : result;
  }

  private async withAutoCompactStatus<Thread extends ThreadPayload>(thread: Thread): Promise<Thread> {
    if (thread.isDraft) return thread;
    const willAutoCompact = await this.owners.autoCompact.observe({
      harness: thread.harness,
      threadId: thread.id,
    });
    return { ...thread, willAutoCompact };
  }

  /** Stop on a parent agent's behalf: interrupt the live turn, then mark stopped, dismissing the questionnaire that interruption retains. */
  async stopThread(threadId: WorkbenchThreadId) {
    const target = await this.target(threadId);
    const turn = await target.provider.threads.latestTurn(target.identity.threadId);
    if (turn?.status === "inProgress") await this.interruptThread(target);
    const entry = await this.owners.state.getCanonicalThreadEntry(target.identity.projectId, target.identity.threadId);
    const requestKey = entry && entry.entryKind !== "draft" ? entry.pendingQuestionnaire?.requestKey : undefined;
    await this.markStopped(target, requestKey, "");
  }

  private async stop(input: WorkbenchThreadStop, connectionId?: string): Promise<{ ok: true }> {
    const target = await this.target(input.threadId);
    await this.interruptThread(target);
    await this.markStopped(target, input.requestKey, connectionId ?? "");
    return { ok: true };
  }

  private async interruptThread({ identity, provider }: ActionTarget) {
    await provider.threads.interrupt(identity.threadId);
    // A turn whose runtime died with an earlier daemon has nobody left to settle it.
    const turn = await provider.threads.latestTurn(identity.threadId);
    if (turn?.status === "inProgress") await this.owners.settlement.settleIfOrphaned(identity.threadId, turn.id);
  }

  /** Mark stopped, dismissing the questionnaire the caller saw (or none); rejects if it changed. */
  private async markStopped(target: ActionTarget, requestKey: string | undefined, connectionId: string) {
    await this.mutateState(connectionId, "dismissed", {
      method: "workbench/thread-state/stop", ...stateTarget(target), ...(requestKey ? { requestKey } : {}),
    });
  }

  /** Interrupt the questionnaire's turn and snooze the thread, keeping the questionnaire. */
  private async snoozeQuestionnaire(target: ActionTarget, requestKey: string, connectionId: string) {
    await this.mutateState(connectionId, "snoozed", {
      method: "workbench/thread-state/questionnaire/snooze", ...stateTarget(target), requestKey,
    });
  }

  private async mutateState(connectionId: string, outcome: string, request: Parameters<WorkbenchThreadActionOwners["state"]["handleRequest"]>[1]) {
    const response = await this.owners.state.handleRequest(connectionId, request);
    if ("error" in response) throw new Error(response.error.message);
    if (typeof response.result === "object" && response.result !== null && "accepted" in response.result && !response.result.accepted) {
      throw new Error(`The pending questionnaire changed before it could be ${outcome}.`);
    }
  }

  /** Only an undelivered steer can be resent or dismissed; a pending one is still held for delivery. */
  private async undeliveredSteer({ threadId, itemId }: WorkbenchThreadSteerTarget) {
    const { identity } = await this.target(threadId);
    const entry = (await this.owners.transcripts.history(identity.threadId)).steerEntries
      .find(candidate => candidate.itemId === itemId);
    if (!entry) throw new Error("The steer is no longer in this thread's history.");
    if (entry.status !== "failed" && entry.status !== "interrupted") {
      throw new Error("Only an undelivered steer can be resent or dismissed.");
    }
    return { identity, entry, itemId: WorkbenchItemIdSchema.parse(itemId) };
  }

  private async recordDismissed(steer: Awaited<ReturnType<WorkbenchThreadActionController["undeliveredSteer"]>>) {
    const now = Date.now();
    await this.owners.transcript.record([{
      kind: "steer",
      entry: {
        ...steer.entry, threadId: WorkbenchThreadIdSchema.parse(steer.entry.threadId),
        turnId: WorkbenchTurnIdSchema.parse(steer.entry.turnId), status: "dismissed", resolvedAt: now, error: null,
      },
      publicItemId: steer.itemId,
      observedAt: now,
    }], { source: "workbench" });
  }

  private async dismissSteer(input: WorkbenchThreadSteerTarget) {
    await this.recordDismissed(await this.undeliveredSteer(input));
    return { ok: true as const };
  }

  /** A running shell sits in the latest turn; Codex names its own shell items, reached only through their source aliases. */
  private async stopShell({ threadId, itemId }: WorkbenchThreadShellTarget) {
    const { identity } = await this.target(threadId);
    const snapshot = await this.owners.transcript.read({ threadId: identity.threadId, turnLimit: 1 });
    const references = [itemId, ...(snapshot?.rows.itemSourceAliases ?? [])
      .filter(alias => alias.item_identity_id === itemId)
      .map(alias => alias.reference)];
    if (!this.owners.shells.stopShell(identity.threadId, references)) throw new Error("This command is no longer running.");
    return { ok: true as const };
  }

  /** Submit the held input as a fresh message, then retire the undelivered copy it replaces. */
  private async resendSteer(input: WorkbenchThreadSteerTarget) {
    const steer = await this.undeliveredSteer(input);
    const result = await this.message({
      threadId: steer.identity.threadId, clientMessageId: randomUUID(), intent: "continue",
      input: WorkbenchUserInputSchema.array().parse(steer.entry.input),
    });
    await this.recordDismissed(steer);
    return result;
  }

  /**
   * Agents cannot press resend, so their undelivered messages follow the thread into its next running turn,
   * oldest first. They steer only a turn that is still running; one that already ended leaves them undelivered
   * for the next turn, so a thread waiting on its user is not woken. User steers keep their resend/dismiss controls.
   */
  resendUndeliveredAgentMessages(threadId: string, turnId: string) {
    const run = (this.redeliveries.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.redeliverAgentMessages(threadId, turnId));
    this.redeliveries.set(threadId, run);
    // The caller owns run's failure; this chain only retires the slot.
    void run.then(() => undefined, () => undefined).then(() => {
      if (this.redeliveries.get(threadId) === run) this.redeliveries.delete(threadId);
    });
    return run;
  }

  private async redeliverAgentMessages(threadId: string, turnId: string) {
    const { identity, provider } = await this.target(threadId);
    const stranded = (await this.owners.transcripts.history(identity.threadId)).steerEntries
      .filter(entry => (entry.status === "failed" || entry.status === "interrupted")
        && entry.itemId && readWorkbenchAgentMessageInput(entry.input))
      .sort((left, right) => left.attemptedAt - right.attemptedAt);
    if (!stranded.length || !await provider.threads.isTurnLive(identity.threadId, turnId)) return;
    for (const entry of stranded) {
      await provider.threads.submit({
        threadId: identity.threadId, clientMessageId: randomUUID(), intent: "steer", expectedTurnId: turnId,
        input: WorkbenchUserInputSchema.array().parse(entry.input),
      });
      await this.recordDismissed({ identity, entry, itemId: WorkbenchItemIdSchema.parse(entry.itemId) });
    }
  }
}

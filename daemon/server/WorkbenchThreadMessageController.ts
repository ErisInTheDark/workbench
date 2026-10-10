/*
 * Exports:
 * - WorkbenchThreadMessageControllerOptions: provider, identity, project, relationship and thread-state ports.
 * - default WorkbenchThreadMessageController: own message admission, Workbench notices, sender lookup, message waits and their undelivered mail, questionnaire settlement, and reload drain.
 */
import type {
  WorkbenchHarness,
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  ThreadReferenceSchema,
  WorkbenchTurnIdSchema,
  type ProjectId,
  type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchQuestionnaireHistoryEntryState, WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { isWorkbenchMcpQuestionnaireRequestKey } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { isThreadStatusActive } from "workbench-shared/workbench/thread/thread-runtime-state";
import {
  WorkbenchThreadMessageRequestSchema,
  WorkbenchMessageWaitRequestSchema,
  type WorkbenchThreadMessageRequest,
} from "workbench-shared/workbench/thread/thread-message";
import type {
  AgentEndpointProjectResolution,
  AgentEndpointProjectResolver,
} from "./lib/workbench/project/agent-endpoint-project";
import { createEmptySubagentQuestionnaireResponse } from "./lib/workbench/subagent/subagent-output";
import type WorkbenchProvider from "./WorkbenchProvider";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import type { WorkbenchQuestionnaireResponseStatePort } from "./WorkbenchQuestionnaireResponseController";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import WorkbenchMessageWaitController, { type WorkbenchMessageWaitHandoff } from "./WorkbenchMessageWaitController";

const PARENT_AGENT_NAME = "parent agent";

interface SubagentRelationshipList {
  subagents: WorkbenchSubagentRelationship[];
}

export interface WorkbenchThreadMessageControllerOptions {
  identities: Pick<WorkbenchThreadIdentityController, "resolve">;
  listSubagents(projectId: ProjectId): Promise<SubagentRelationshipList>;
  provider(harness: WorkbenchHarness): Pick<WorkbenchProvider, "threads" | "interactions">;
  questionnaires: Pick<WorkbenchQuestionnaireController, "canDeliver" | "deliver">;
  recordQuestionnaire(entry: WorkbenchQuestionnaireHistoryEntryState): Promise<void>;
  resolveProjectFromCwd: AgentEndpointProjectResolver;
  threadState: {
    getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
    resolvePendingQuestionnaire: WorkbenchQuestionnaireResponseStatePort["resolvePendingQuestionnaire"];
  };
}

function buildSubagentPromptContext(name: string, workbenchOrigin: string | undefined): WorkbenchMessageContext {
  return {
    subagentName: name,
    workbenchOrigin: workbenchOrigin ?? null,
    workflowIds: ["subagent"],
  };
}

export default class WorkbenchThreadMessageController {
  private active = true;
  private readonly requests = new Set<Promise<void>>();
  private readonly waits: WorkbenchMessageWaitController;

  constructor(private readonly options: WorkbenchThreadMessageControllerOptions, handoff?: WorkbenchMessageWaitHandoff) {
    this.waits = new WorkbenchMessageWaitController(handoff);
  }

  captureReloadState() { return this.waits.captureReloadState(); }

  receive(threadId: string, message: WorkbenchAgentMessage) { this.waits.receive(threadId, message); }

  delivered(threadId: string, message: WorkbenchAgentMessage) { this.waits.delivered(threadId, message); }

  async wait(value: object, signal: AbortSignal, invocationSignal = signal) {
    const request = WorkbenchMessageWaitRequestSchema.parse(value);
    signal.throwIfAborted();
    const requestedProject = await this.options.resolveProjectFromCwd(request.cwd, { endpointName: "Workbench message wait" });
    const caller = await this.resolveThread(request.callerThreadId, "Workbench message wait caller", requestedProject.project);
    let senderThreadIds: WorkbenchThreadId[] = [];
    if (!this.waits.hasWait(request.waitId)) {
      const relationships = (await this.options.listSubagents(caller.projectId)).subagents;
      const targets = await Promise.all([
        ...(request.threadIds ?? []).map(threadId => this.resolveTarget({ threadId }, caller.threadId, relationships)),
        ...(request.names ?? []).map(name => this.resolveTarget({ name }, caller.threadId, relationships)),
      ]);
      senderThreadIds = [...new Set(targets.map(target => target.threadId))];
      if (senderThreadIds.includes(caller.threadId)) throw new Error("A thread cannot wait for a message from itself.");
    }
    if (!this.active) throw new Error("Thread message controller is draining for runtime reload.");
    return await this.waits.wait({ waitId: request.waitId, callerThreadId: caller.threadId, senderThreadIds }, signal, invocationSignal);
  }

  beginRuntimeDrain() {
    this.active = false;
  }

  async dispose() {
    this.beginRuntimeDrain();
    this.waits.dispose();
    await Promise.all(this.requests);
  }

  send(value: unknown) {
    const request = WorkbenchThreadMessageRequestSchema.parse(value);
    if (!this.active) return Promise.reject(new Error("Thread message controller is draining for runtime reload."));
    const operation = this.sendOwned(request);
    this.requests.add(operation);
    return operation.finally(() => this.requests.delete(operation));
  }

  /** Deliver a Workbench-originated notice (e.g. a subagent queue handoff) through the normal agent-message steer path. */
  sendNotice(input: {
    threadId: WorkbenchThreadId;
    senderThreadId: WorkbenchThreadId;
    senderName: string;
    message: string;
    userVisibleSimpleVersion: string;
  }) {
    if (!this.active) return Promise.reject(new Error("Thread message controller is draining for runtime reload."));
    const operation = (async () => {
      const target = await this.resolveThread(input.threadId, "Workbench notice target");
      await this.options.provider(target.harness).threads.messageAgent({
        cwd: target.thread.cwd,
        threadId: target.threadId,
        message: {
          message: input.message,
          senderName: input.senderName,
          senderThreadId: input.senderThreadId,
          userVisibleSimpleVersion: input.userVisibleSimpleVersion,
        },
      });
    })();
    this.requests.add(operation);
    return operation.finally(() => this.requests.delete(operation));
  }

  /** Resolves any admitted thread; `requiredProject` fences it to one cwd project. */
  private async resolveThread(
    threadId: string,
    label: string,
    requiredProject?: AgentEndpointProjectResolution["project"],
  ) {
    const identity = await this.options.identities.resolve({
      ...(requiredProject ? { projectId: requiredProject.id } : {}),
      threadId: ThreadReferenceSchema.parse(threadId),
    });
    if (!identity) throw new Error(`${label} has no admitted identity${requiredProject ? " in this project" : ""}.`);
    const nativeHarness = identity.bindings[0]?.harness;
    if (!nativeHarness) throw new Error(`${label} has no native execution.`);
    const harness = WorkbenchHarnessSchema.parse(nativeHarness);
    const thread = await this.options.provider(harness).threads.read(identity.threadId);
    const { project } = await this.options.resolveProjectFromCwd(thread.cwd, { endpointName: label });
    if (requiredProject && project.id !== requiredProject.id) throw new Error(`${label} does not belong to this cwd project.`);
    return { harness, projectId: project.id, thread, threadId: identity.threadId };
  }

  private async isUnsettled(record: WorkbenchSubagentRelationship) {
    const entry = await this.options.threadState.getEntry(record.projectId, record.harness, record.threadId);
    return !entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled;
  }

  private async resolveTarget(
    request: Pick<WorkbenchThreadMessageRequest, "name" | "parent" | "threadId">,
    callerThreadId: WorkbenchThreadId,
    relationships: readonly WorkbenchSubagentRelationship[],
  ) {
    if (request.parent) {
      const relationship = relationships.find(record => record.threadId === callerThreadId);
      if (!relationship) {
        throw new Error("The current thread is not a Workbench subagent with a direct parent in this project.");
      }
      return await this.resolveThread(relationship.parentThreadId, "Workbench message parent");
    }
    if (request.name) {
      // Subagents reach siblings only by a name their parent gave them; there is no peer lookup.
      const callerParentThreadId = relationships.find(record => record.threadId === callerThreadId)?.parentThreadId ?? null;
      const matches = relationships.filter(record => (
        (record.parentThreadId === callerThreadId
          || (callerParentThreadId !== null && record.parentThreadId === callerParentThreadId && record.threadId !== callerThreadId))
        && record.name.trim().toLocaleLowerCase() === request.name!.toLocaleLowerCase()
      ));
      const unsettled = (await Promise.all(matches.map(async record => ({
        record,
        unsettled: await this.isUnsettled(record),
      })))).filter(result => result.unsettled).map(({ record }) => record);
      if (unsettled.length !== 1) {
        throw new Error(unsettled.length ? "That subagent name is ambiguous." : "That unsettled subagent name was not found.");
      }
      const relationship = unsettled[0]!;
      return await this.resolveThread(relationship.threadId, "Workbench message target");
    }
    return await this.resolveThread(request.threadId!, "Workbench message target");
  }

  private async assertUnlocked(
    projectId: ProjectId,
    relationship: WorkbenchSubagentRelationship | null,
  ) {
    if (!relationship) return;
    const entry = await this.options.threadState.getEntry(projectId, relationship.harness, relationship.threadId);
    if (entry?.entryKind === "subagent" && entry.pinned) {
      throw new Error(`Subagent ${entry.name} is locked: this subagent is user-owned and may send you follow-up messages.`);
    }
  }

  private async sendOwned(request: WorkbenchThreadMessageRequest) {
    const requestedProject = await this.options.resolveProjectFromCwd(request.cwd, { endpointName: "Workbench message" });
    const caller = await this.resolveThread(request.callerThreadId, "Workbench message caller", requestedProject.project);
    const relationships = (await this.options.listSubagents(caller.projectId)).subagents;
    const target = await this.resolveTarget(request, caller.threadId, relationships);
    if (target.threadId === caller.threadId) throw new Error("A thread cannot message itself.");

    const targetRelationships = target.projectId === caller.projectId
      ? relationships
      : (await this.options.listSubagents(target.projectId)).subagents;
    const targetRelationship = targetRelationships.find(record => record.threadId === target.threadId) ?? null;
    await this.assertUnlocked(target.projectId, targetRelationship);

    const directChild = targetRelationship?.parentThreadId === caller.threadId ? targetRelationship : null;
    const callerRelationship = relationships.find(record => record.threadId === caller.threadId) ?? null;
    const directParent = callerRelationship?.parentThreadId === target.threadId ? callerRelationship : null;
    const senderName = directChild
      ? PARENT_AGENT_NAME
      : directParent?.name ?? (
        caller.thread.name?.trim()
        || caller.thread.agentNickname?.trim()
        || "agent"
      );
    const provider = this.options.provider(target.harness);
    const input = {
      cwd: target.thread.cwd,
      threadId: target.threadId,
      message: {
        message: request.message,
        senderName,
        senderThreadId: caller.threadId,
        userVisibleSimpleVersion: request.userVisibleSimpleVersion,
      },
    };
    const active = isThreadStatusActive(target.thread.status);
    const entry = directChild
      ? await this.options.threadState.getEntry(target.projectId, target.harness, target.threadId)
      : null;
    const stored = entry && entry.entryKind !== "draft" ? entry.pendingQuestionnaire : null;
    const question = stored && isWorkbenchMcpQuestionnaireRequestKey(stored.requestKey) ? stored : null;
    const nativeQuestion = directChild && active && !question
      ? (await provider.interactions?.pending({ background: true }) ?? [])
        .find(pending => pending.threadId === target.threadId) ?? null
      : null;
    const admitted = await provider.threads.messageAgent({
      ...input,
      ...(directChild && !active ? { context: buildSubagentPromptContext(directChild.name, request.workbenchOrigin) } : {}),
    });
    if (question) {
      const response = createEmptySubagentQuestionnaireResponse(question.request);
      const replaced = new Error("The captured questionnaire was replaced.");
      const settled = await this.options.threadState.resolvePendingQuestionnaire({
        projectId: target.projectId,
        harness: target.harness,
        threadId: target.threadId,
        requestKey: question.requestKey,
        resolvedAt: Date.now(),
        response,
      }, async ({ questionnaire }) => {
        // Request keys can be reused while message admission is awaiting the provider.
        if (questionnaire.itemId !== question.itemId) throw replaced;
        if (this.options.questionnaires.canDeliver(target.threadId, question.requestKey)) {
          const delivered = await this.options.questionnaires.deliver({
            threadId: target.threadId,
            requestKey: question.requestKey,
            response,
          });
          if (!delivered) throw new Error("The questionnaire waiter detached before delivery.");
        }
        return {
          delivery: undefined,
          turnId: WorkbenchTurnIdSchema.parse(admitted.turnId),
          insertAfterItemId: null,
          insertAfterItemIndex: null,
        };
      }).catch(error => {
        if (error !== replaced) throw error;
        return null;
      });
      if (settled) {
        try {
          await this.options.recordQuestionnaire(settled.historyEntry);
        } catch {
          console.warn("[thread-message] Message and questionnaire answer accepted, but transcript recording failed.");
        }
      }
    } else if (nativeQuestion) {
      await provider.interactions!.respond({
        requestKey: nativeQuestion.requestKey,
        response: createEmptySubagentQuestionnaireResponse(nativeQuestion.request),
        threadId: target.threadId,
        turnId: nativeQuestion.turnId,
        insertAfterItemId: null,
        insertAfterItemIndex: null,
      });
    }
  }
}

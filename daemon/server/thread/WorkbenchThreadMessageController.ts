/*
 * Exports:
 * - WorkbenchThreadMessageControllerOptions: provider, identity, project, relationship and thread-state ports.
 * - default WorkbenchThreadMessageController: own message admission (including messages to and from threads on other daemons), Workbench
 *   notices, sender lookup, message waits and their undelivered mail, parent questionnaire settlement, and reload drain.
 */
import type {
  WorkbenchHarness,
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  ThreadReferenceSchema,
  WorkbenchTurnIdSchema,
  type DaemonId,
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
} from "../lib/workbench/project/agent-endpoint-project";
import { createEmptySubagentQuestionnaireResponse } from "../lib/workbench/subagent/subagent-output";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchQuestionnaireController from "../interactions/WorkbenchQuestionnaireController";
import type { WorkbenchQuestionnaireResponseStatePort } from "../interactions/WorkbenchQuestionnaireResponseController";
import type { WorkbenchAgentMessage } from "workbench-shared/workbench/thread/thread-agent-message";
import WorkbenchMessageWaitController, { type WorkbenchMessageWaitHandoff } from "../agent/WorkbenchMessageWaitController";
import type { RemoteCall, RemoteCaller, SiblingRosterEntry } from "workbench-shared/workbench/network/network-remote-calls";
import type { NetworkCaller } from "../network/WorkbenchNetworkAccessController";

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
  /** Messages to threads on other daemons; absent where no relay exists. */
  network?: {
    self(): DaemonId | null;
    /** A message the target authorizes from its own family records; never prompts. */
    messageFamily(caller: { threadId: WorkbenchThreadId; title: string }, daemonId: DaemonId,
      message: Omit<Extract<RemoteCall, { kind: "message" }>, "kind">): Promise<void>;
    /** A message to a thread named by id; the target's refusal prompts the user once. */
    messageThread(caller: NetworkCaller, threadId: string, message: { message: string; userVisibleSimpleVersion: string; senderName: string },
      signal: AbortSignal): Promise<void>;
    roster(threadId: WorkbenchThreadId): Promise<SiblingRosterEntry[]>;
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
  /** Cancels network prompts still awaiting the user when the runtime drains. */
  private readonly lifetime = new AbortController();

  constructor(private readonly options: WorkbenchThreadMessageControllerOptions, handoff?: WorkbenchMessageWaitHandoff) {
    this.waits = new WorkbenchMessageWaitController(handoff);
  }

  captureReloadState() { return this.waits.captureReloadState(); }

  isWaitingFor(callerThreadId: WorkbenchThreadId, senderThreadId: WorkbenchThreadId) {
    return this.waits.isWaitingFor(callerThreadId, senderThreadId);
  }

  subscribePending(listener: () => void) { return this.waits.subscribePending(listener); }

  receive(threadId: string, message: WorkbenchAgentMessage) { this.waits.receive(threadId, message); }

  delivered(threadId: string, message: WorkbenchAgentMessage) { this.waits.delivered(threadId, message); }

  undeliveredSenders(threadId: string) { return this.waits.undeliveredSenders(threadId); }
  undeliveredThreadIds() { return this.waits.undeliveredThreadIds(); }

  async wait(value: object, signal: AbortSignal, invocationSignal = signal) {
    const request = WorkbenchMessageWaitRequestSchema.parse(value);
    signal.throwIfAborted();
    const requestedProject = await this.options.resolveProjectFromCwd(request.cwd, { endpointName: "Workbench message wait" });
    const caller = await this.resolveThread(request.callerThreadId, "Workbench message wait caller", requestedProject.project);
    let senderThreadIds: WorkbenchThreadId[] = [];
    if (!this.waits.hasWait(request.waitId)) {
      const relationships = (await this.options.listSubagents(caller.projectId)).subagents;
      // A thread on another daemon can only wake this wait by messaging it, which its own grant or family tie authorizes.
      const remoteSenders = this.options.network ? await Promise.all((request.threadIds ?? []).map(async (threadId: string) =>
        await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) }) ? null : threadId)) : [];
      const remoteIds = remoteSenders.filter((threadId): threadId is string => threadId !== null);
      const targets = await Promise.all([
        ...remoteIds.map(threadId => ({ threadId: threadId as unknown as WorkbenchThreadId })),
        ...(request.threadIds ?? []).filter((threadId: string) => !remoteIds.includes(threadId))
          .map(threadId => this.resolveTarget({ threadId }, caller.threadId, relationships)),
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
    if (!this.lifetime.signal.aborted) this.lifetime.abort(new Error("Thread message controller is draining for runtime reload."));
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
    const callerName = caller.thread.name?.trim() || caller.thread.agentNickname?.trim() || "agent";
    if (await this.sendAcrossDaemons(request, { ...caller, name: callerName }, relationships)) return;
    const target = await this.resolveTarget(request, caller.threadId, relationships);
    if (target.threadId === caller.threadId) throw new Error("A thread cannot message itself.");

    const targetRelationships = target.projectId === caller.projectId
      ? relationships
      : (await this.options.listSubagents(target.projectId)).subagents;
    const targetRelationship = targetRelationships.find(record => record.threadId === target.threadId) ?? null;
    await this.assertUnlocked(target.projectId, targetRelationship);

    const directChild = !request.threadId && targetRelationship?.parentThreadId === caller.threadId
      ? targetRelationship
      : null;
    const callerRelationship = relationships.find(record => record.threadId === caller.threadId) ?? null;
    const directParent = callerRelationship?.parentThreadId === target.threadId ? callerRelationship : null;
    const senderName = directChild ? PARENT_AGENT_NAME : directParent?.name ?? callerName;
    await this.admit(target, { senderName, senderThreadId: caller.threadId }, directChild, request);
  }

  /**
   * Sends to a thread on another daemon when the target lives there: a parent, a child or sibling in another folder, or a
   * thread named by id that this daemon does not hold. Returns false for local targets.
   */
  private async sendAcrossDaemons(
    request: WorkbenchThreadMessageRequest,
    caller: { threadId: WorkbenchThreadId; projectId: ProjectId; name: string; thread: { cwd: string } },
    relationships: readonly WorkbenchSubagentRelationship[],
  ) {
    const network = this.options.network;
    if (!network) return false;
    const message = { message: request.message, userVisibleSimpleVersion: request.userVisibleSimpleVersion };
    const self = network.self();
    const callerRelationship = relationships.find(record => record.threadId === caller.threadId) ?? null;
    const family = async (daemonId: DaemonId, threadId: WorkbenchThreadId, senderName: string) => {
      await network.messageFamily({ threadId: caller.threadId, title: caller.name }, daemonId, { ...message, threadId, senderName });
      return true;
    };
    if (request.parent) {
      return callerRelationship?.parent ? await family(callerRelationship.parent.daemonId, callerRelationship.parentThreadId, callerRelationship.name) : false;
    }
    if (request.name) {
      const name = request.name.toLocaleLowerCase();
      const parentThreadId = callerRelationship?.parentThreadId ?? caller.threadId;
      const remoteRecord = relationships.find(record => record.location && record.location.daemonId !== self && record.location.settledAt === null
        && record.parentThreadId === parentThreadId && record.threadId !== caller.threadId && record.name.toLocaleLowerCase() === name);
      if (remoteRecord) return await family(remoteRecord.location!.daemonId, remoteRecord.threadId,
        remoteRecord.parentThreadId === caller.threadId ? PARENT_AGENT_NAME : callerRelationship?.name ?? caller.name);
      if (!callerRelationship?.parent) return false;
      const localSibling = relationships.some(record => record.parentThreadId === callerRelationship.parentThreadId
        && record.threadId !== caller.threadId && record.name.toLocaleLowerCase() === name);
      if (localSibling) return false;
      const sibling = (await network.roster(caller.threadId)).find(entry => entry.name.toLocaleLowerCase() === name && entry.daemonId !== self);
      if (!sibling) throw new Error("That sibling is not on your parent's latest roster; ask your parent to message it.");
      return await family(sibling.daemonId, sibling.threadId, callerRelationship.name);
    }
    if (!request.threadId) return false;
    if (await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(request.threadId) })) return false;
    await network.messageThread({ threadId: caller.threadId, cwd: caller.thread.cwd, title: caller.name, projectId: caller.projectId },
      request.threadId, { ...message, senderName: callerRelationship?.name ?? caller.name }, this.lifetime.signal);
    return true;
  }

  /** Admits a message another daemon's thread relayed here; the remote-call owner already authorized it. */
  async admitRemote(caller: RemoteCaller, call: Extract<RemoteCall, { kind: "message" }>) {
    if (!this.active) throw new Error("Thread message controller is draining for runtime reload.");
    const target = await this.resolveThread(call.threadId, "Workbench message target");
    const relationship = (await this.options.listSubagents(target.projectId)).subagents
      .find(record => record.threadId === target.threadId) ?? null;
    await this.assertUnlocked(target.projectId, relationship);
    const directChild = relationship?.parent?.daemonId === caller.daemonId && relationship.parentThreadId === caller.threadId ? relationship : null;
    await this.admit(target, {
      senderName: directChild ? PARENT_AGENT_NAME : call.senderName, senderThreadId: caller.threadId, senderHost: caller.hostname,
    }, directChild, { message: call.message, userVisibleSimpleVersion: call.userVisibleSimpleVersion });
  }

  /** Delivers one attributed message; a parent's message also settles its child's held questionnaire. */
  private async admit(
    target: Awaited<ReturnType<WorkbenchThreadMessageController["resolveThread"]>>,
    sender: { senderName: string; senderThreadId: WorkbenchThreadId; senderHost?: string },
    directChild: WorkbenchSubagentRelationship | null,
    request: { message: string; userVisibleSimpleVersion: string; workbenchOrigin?: string | undefined },
  ) {
    const provider = this.options.provider(target.harness);
    const input = {
      cwd: target.thread.cwd,
      threadId: target.threadId,
      message: { message: request.message, ...sender, userVisibleSimpleVersion: request.userVisibleSimpleVersion },
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

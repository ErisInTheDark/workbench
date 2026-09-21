/*
 * Exports:
 * - WorkbenchThreadMessageControllerOptions: provider, identity, project, relationship and thread-state ports.
 * - default WorkbenchThreadMessageController: own validated cross-thread message admission and reload drain.
 */
import type {
  ThreadPayload,
  WorkbenchHarness,
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  ThreadReferenceSchema,
  type ProjectId,
  type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import {
  WorkbenchThreadMessageRequestSchema,
  type WorkbenchThreadMessageRequest,
} from "workbench-shared/workbench/thread/thread-message";
import type {
  AgentEndpointProjectResolution,
  AgentEndpointProjectResolver,
} from "./lib/workbench/project/agent-endpoint-project";
import { createEmptySubagentQuestionnaireResponse } from "./lib/workbench/subagent/subagent-output";
import type WorkbenchProvider from "./WorkbenchProvider";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

const PARENT_AGENT_NAME = "parent agent";

interface SubagentRelationshipList {
  subagents: WorkbenchSubagentRelationship[];
}

export interface WorkbenchThreadMessageControllerOptions {
  identities: Pick<WorkbenchThreadIdentityController, "resolve">;
  listSubagents(projectId: ProjectId): Promise<SubagentRelationshipList>;
  provider(harness: WorkbenchHarness): Pick<WorkbenchProvider, "threads" | "interactions">;
  resolveProjectFromCwd: AgentEndpointProjectResolver;
  threadState: {
    getEntry(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadSidebarEntry | null>;
  };
}

function currentTurn(thread: ThreadPayload) {
  return thread.turns.at(-1) ?? null;
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

  constructor(private readonly options: WorkbenchThreadMessageControllerOptions) {}

  beginRuntimeDrain() {
    this.active = false;
  }

  async dispose() {
    this.beginRuntimeDrain();
    await Promise.all(this.requests);
  }

  send(value: unknown) {
    const request = WorkbenchThreadMessageRequestSchema.parse(value);
    if (!this.active) return Promise.reject(new Error("Thread message controller is draining for runtime reload."));
    const operation = this.sendOwned(request);
    this.requests.add(operation);
    return operation.finally(() => this.requests.delete(operation));
  }

  private async resolveThread(
    threadId: string,
    project: AgentEndpointProjectResolution["project"],
    label: string,
  ) {
    const identity = await this.options.identities.resolve({
      projectId: project.id,
      threadId: ThreadReferenceSchema.parse(threadId),
    });
    if (!identity) throw new Error(`${label} has no admitted identity in this project.`);
    const nativeHarness = identity.bindings[0]?.harness;
    if (!nativeHarness) throw new Error(`${label} has no native execution.`);
    const harness = WorkbenchHarnessSchema.parse(nativeHarness);
    const thread = await this.options.provider(harness).threads.read(identity.threadId);
    const threadProject = await this.options.resolveProjectFromCwd(thread.cwd, { endpointName: label });
    if (threadProject.project.id !== project.id) throw new Error(`${label} does not belong to this cwd project.`);
    return { harness, thread, threadId: identity.threadId };
  }

  private async isUnsettled(record: WorkbenchSubagentRelationship) {
    const entry = await this.options.threadState.getEntry(record.projectId, record.harness, record.threadId);
    return !entry || entry.entryKind !== "subagent" || !entry.lifecycle.settled;
  }

  private async resolveTarget(
    request: WorkbenchThreadMessageRequest,
    callerThreadId: WorkbenchThreadId,
    project: AgentEndpointProjectResolution["project"],
    relationships: readonly WorkbenchSubagentRelationship[],
  ) {
    if (request.parent) {
      const relationship = relationships.find(record => record.threadId === callerThreadId);
      if (!relationship) {
        throw new Error("The current thread is not a Workbench subagent with a direct parent in this project.");
      }
      return await this.resolveThread(relationship.parentThreadId, project, "Workbench message parent");
    }
    if (request.name) {
      const matches = relationships.filter(record => (
        record.parentThreadId === callerThreadId
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
      return await this.resolveThread(relationship.threadId, project, "Workbench message target");
    }
    return await this.resolveThread(request.threadId!, project, "Workbench message target");
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
    const caller = await this.resolveThread(request.callerThreadId, requestedProject.project, "Workbench message caller");
    const relationshipList = await this.options.listSubagents(requestedProject.project.id);
    const relationships = relationshipList.subagents;
    const target = await this.resolveTarget(request, caller.threadId, requestedProject.project, relationships);
    if (target.threadId === caller.threadId) throw new Error("A thread cannot message itself.");

    const targetRelationship = relationships.find(record => record.threadId === target.threadId) ?? null;
    await this.assertUnlocked(requestedProject.project.id, targetRelationship);

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
      },
    };
    const turn = currentTurn(target.thread);
    if (turn?.status === "inProgress") {
      const pending = directChild
        ? (await provider.interactions?.pending({ background: true }) ?? [])
          .find(entry => entry.threadId === target.threadId) ?? null
        : null;
      await provider.threads.messageAgent(input);
      if (pending) {
        await provider.interactions!.respond({
          requestKey: pending.requestKey,
          response: createEmptySubagentQuestionnaireResponse(pending.request),
          threadId: target.threadId,
          turnId: pending.turnId,
          insertAfterItemId: null,
          insertAfterItemIndex: null,
        });
      }
      return;
    }
    await provider.threads.messageAgent({
      ...input,
      ...(directChild ? { context: buildSubagentPromptContext(directChild.name, request.workbenchOrigin) } : {}),
    });
  }
}

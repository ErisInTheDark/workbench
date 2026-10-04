/*
 * Exports:
 * - WorkbenchThreadMessageControllerOptions: provider, identity, project, relationship and thread-state ports.
 * - default WorkbenchThreadMessageController: own validated cross-thread message admission (child or sibling names, parent, thread ids), admitted-turn intent acceptance, and reload drain.
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
    /** Mark the target working on the turn that admitted the message, as user messages do. */
    acceptIntent(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId, turnId: string): Promise<void>;
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
    request: WorkbenchThreadMessageRequest,
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
    // Waiters read lifecycle; without this a re-messaged child still looks finished until provider events land.
    const accept = (admitted: { turnId: string }) => this.options.threadState.acceptIntent(
      target.projectId, target.harness, target.threadId, admitted.turnId,
    );
    const turn = currentTurn(target.thread);
    if (turn?.status === "inProgress") {
      const pending = directChild
        ? (await provider.interactions?.pending({ background: true }) ?? [])
          .find(entry => entry.threadId === target.threadId) ?? null
        : null;
      await accept(await provider.threads.messageAgent(input));
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
    await accept(await provider.threads.messageAgent({
      ...input,
      ...(directChild ? { context: buildSubagentPromptContext(directChild.name, request.workbenchOrigin) } : {}),
    }));
  }
}

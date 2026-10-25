/*
 * Exports:
 * - default WorkbenchCoreSubagentsFeature: build subagent relationships and settle/handover, agent messages and their waits, and subagent turn queues.
 */
import { ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateRequest } from "workbench-shared/workbench/thread/thread-state";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import type WorkbenchApprovalController from "../interactions/WorkbenchApprovalController";
import type WorkbenchComposerProfileStore from "../store/WorkbenchComposerProfileStore";
import type WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import type { WorkbenchMessageWaitHandoff } from "../agent/WorkbenchMessageWaitController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchQuestionnaireController from "../interactions/WorkbenchQuestionnaireController";
import WorkbenchSubagentFeature from "../subagents/WorkbenchSubagentFeature";
import WorkbenchSubagentQueueController, { type WorkbenchSubagentQueueHandoff } from "../subagents/WorkbenchSubagentQueueController";
import type WorkbenchThreadActionController from "../thread/WorkbenchThreadActionController";
import WorkbenchThreadMessageController from "../thread/WorkbenchThreadMessageController";
import type WorkbenchThreadStateFeature from "../thread/WorkbenchThreadStateFeature";
import type WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";
import type WorkbenchThreadFactsFeature from "./WorkbenchThreadFactsFeature";
import type { WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";

export default class WorkbenchCoreSubagentsFeature {
  readonly subagents: WorkbenchSubagentFeature;
  readonly messages: WorkbenchThreadMessageController;
  readonly queues: WorkbenchSubagentQueueController;

  constructor(ports: {
    database: DaemonDatabaseRegistration;
    transcript: Pick<WorkbenchCoreTranscript, "record">;
    identities: DaemonRuntimeObjects["threadIdentity"];
    lookup: WorkbenchCoreThreadLookup;
    projectCatalog: WorkbenchProjectCatalogController;
    profileStore: WorkbenchComposerProfileStore;
    threadState: WorkbenchThreadStateFeature;
    facts: Pick<WorkbenchThreadFactsFeature, "settlementHold" | "todos">;
    gitArc: Pick<WorkbenchGitArcFeature, "executeRequest">;
    /** Built after this feature, read at call time. */
    approvals: () => Pick<WorkbenchApprovalController, "list">;
    questionnaires: () => Pick<WorkbenchQuestionnaireController, "canDeliver" | "deliver">;
    threadActions: () => Pick<WorkbenchThreadActionController, "stopThread">;
    messageWaitHandoff?: WorkbenchMessageWaitHandoff;
    subagentQueueHandoff?: WorkbenchSubagentQueueHandoff;
  }) {
    const { identities, lookup, projectCatalog, threadState, facts } = ports;
    const subagents = this.subagents = new WorkbenchSubagentFeature({
      messageWaits: {
        isWaitingFor: (caller, sender) => this.messages.isWaitingFor(caller, sender),
        subscribePending: listener => this.messages.subscribePending(listener),
      },
      identities,
      // Queues are built last in this feature; a note asked for before then has nothing to report.
      queueReleaseNote: threadId => (this.queues as WorkbenchSubagentQueueController | undefined)?.takeReleaseNote(threadId) ?? null,
      settlementHold: threadId => facts.settlementHold(threadId),
      // Handover adopts through the ordinary Git arc ingress so it keeps every ownership gate and rejection.
      adoptChildGitWork: async ({ cwd, harness, name, parentThreadId, transferStash }) => {
        const response = await ports.gitArc.executeRequest({
          action: "arcAdoptSource", cwd, harness, threadId: parentThreadId,
          source: { kind: "subagent", name }, ...(transferStash ? { transferStash } : {}),
        });
        if (response.ok) return;
        const failure = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "Git arc adoption failed.");
      },
      moveTodos: (fromThreadId, toThreadId) => facts.todos.moveAll(fromThreadId, toThreadId),
      provider: harness => lookup.provider(harness),
      liveApprovals: () => ports.approvals().list(),
      onRelationshipCommitted: (record) => threadState.installSubagentRelationship(record),
      resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
      profileStore: ports.profileStore,
      persistence: ports.database,
      stopThread: threadId => ports.threadActions().stopThread(threadId),
      threadState: {
        getEntry: async (projectId, harness, threadId) => threadState.controller.getThreadEntry(projectId, harness, threadId),
        mutate: async (request: WorkbenchThreadStateRequest) => {
          const response = await threadState.controller.handleRequest("subagent-controller", request);
          if (response.error) throw new Error(response.error.message);
          if (!response.result || !("accepted" in response.result)) throw new Error("The subagent settle mutation returned no acceptance decision.");
          return { accepted: response.result.accepted };
        },
        subscribe: (listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) => threadState.controller.subscribe(listener),
      },
    });
    this.messages = new WorkbenchThreadMessageController({
      identities,
      listSubagents: projectId => subagents.listRelationships(projectId),
      provider: harness => lookup.provider(harness),
      questionnaires: {
        canDeliver: (threadId, requestKey) => ports.questionnaires().canDeliver(threadId, requestKey),
        deliver: input => ports.questionnaires().deliver(input),
      },
      recordQuestionnaire: async entry => {
        await ports.transcript.record([{
          kind: "questionnaire",
          entry: {
            ...entry,
            itemId: entry.itemId ?? null,
            insertAfterItemId: entry.insertAfterItemId ?? null,
            insertAfterItemIndex: entry.insertAfterItemIndex ?? null,
            threadId: WorkbenchThreadIdSchema.parse(entry.threadId),
          },
          observedAt: entry.resolvedAt,
        }], { source: "workbench" });
      },
      resolveProjectFromCwd: async (cwd, options) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
      threadState: {
        getEntry: async (projectId, harness, threadId) => await threadState.controller.getThreadEntry(projectId, harness, threadId),
        resolvePendingQuestionnaire: (input, deliver) => threadState.controller.resolvePendingQuestionnaire(input, deliver),
      },
    }, ports.messageWaitHandoff);
    // Its lifecycle listener registers here, after thread state and before any subagent wait subscribes at request time.
    this.queues = new WorkbenchSubagentQueueController({
      resolveProjectFromCwd: async cwd => (
        await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent queue" })
      ).project.id,
      resolveThreadId: async (threadId, projectId) => {
        const identity = await identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId });
        if (!identity) throw new Error("The queue caller has no admitted identity in this project.");
        return identity.threadId;
      },
      listRelationships: async projectId => (await subagents.listRelationships(projectId)).subagents,
      readLifecycle: async (projectId, threadId) => {
        const entry = await threadState.controller.getCanonicalThreadEntry(projectId, threadId);
        return entry && entry.entryKind !== "draft" ? entry.lifecycle : null;
      },
      subscribeLifecycle: listener => threadState.controller.subscribe(listener),
      sendNotice: input => this.messages.sendNotice(input),
      warn: message => { console.warn("[subagent-queue]", message.slice(0, 500)); },
    }, ports.subagentQueueHandoff);
  }
}

/*
 * Exports:
 * - default WorkbenchInteractionsFeature: build questionnaires, approval review, live approvals (daemon-thread patches inside
 *   approved machine claims auto-allow), questionnaire-held steers and questionnaire responses, and read a thread's shown
 *   approval prompt.
 */
import path from "node:path";
import { ProjectIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import { DEFAULT_APPROVAL_MODE, resolveApprovalMode } from "workbench-shared/workbench/approval-review/approval-mode";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";
import type { ThreadRuntime } from "workbench-shared/workbench/thread/thread-state";
import { readOpenCodeApiKey } from "../approval-review/opencode-auth-credential";
import WorkbenchApprovalReviewController from "../approval-review/WorkbenchApprovalReviewController";
import type { DaemonProcessContext } from "../daemon-process-context";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import { readDeviceIdentity } from "../store/device-identity";
import { createWorkbenchQuestionnaireStatePorts } from "../thread/thread-identity-workbench-mapping";
import type WorkbenchAgentContextController from "../agent/WorkbenchAgentContextController";
import WorkbenchApprovalController, { type WorkbenchApprovalHandoff } from "../interactions/WorkbenchApprovalController";
import type WorkbenchHarnessController from "../providers/WorkbenchHarnessController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchProviderDispatcher from "../providers/WorkbenchProviderDispatcher";
import WorkbenchQuestionnaireController from "../interactions/WorkbenchQuestionnaireController";
import WorkbenchQuestionnaireResponseController from "../interactions/WorkbenchQuestionnaireResponseController";
import WorkbenchQuestionnaireSteerController from "../interactions/WorkbenchQuestionnaireSteerController";
import type WorkbenchThreadStateFeature from "../thread/WorkbenchThreadStateFeature";
import type WorkbenchThreadTurnLiveness from "../turn/WorkbenchThreadTurnLiveness";
import type WorkbenchTranscriptReader from "../transcript/WorkbenchTranscriptReader";
import type WorkbenchCoreThreadLookup from "./WorkbenchCoreThreadLookup";
import type WorkbenchThreadFactsFeature from "./WorkbenchThreadFactsFeature";
import type { WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";

export default class WorkbenchInteractionsFeature {
  readonly questionnaires: WorkbenchQuestionnaireController;
  readonly approvalReview: WorkbenchApprovalReviewController;
  readonly approvals: WorkbenchApprovalController;
  readonly questionnaireSteers: WorkbenchQuestionnaireSteerController;
  readonly questionnaireResponses: WorkbenchQuestionnaireResponseController;

  constructor(ports: {
    context: Pick<DaemonProcessContext, "broadcastProviderNotification">;
    database: DaemonDatabaseRegistration;
    transcript: Pick<WorkbenchCoreTranscript, "acceptApprovalOutcome" | "read" | "record">;
    identities: DaemonRuntimeObjects["threadIdentity"];
    transcriptIdentity: DaemonRuntimeObjects["transcriptIdentity"];
    commandApprovals: DaemonRuntimeObjects["commandApprovals"];
    approvalHandoff?: WorkbenchApprovalHandoff;
    lookup: WorkbenchCoreThreadLookup;
    projectCatalog: WorkbenchProjectCatalogController;
    threadState: WorkbenchThreadStateFeature;
    agentContext: Pick<WorkbenchAgentContextController, "collect">;
    facts: Pick<WorkbenchThreadFactsFeature, "readThreadSkills" | "recordUserSkillActivations">;
    harnesses: WorkbenchHarnessController;
    providers: WorkbenchProviderDispatcher;
    turnLiveness: Pick<WorkbenchThreadTurnLiveness, "read">;
    transcriptReader: Pick<WorkbenchTranscriptReader, "history">;
    publishRuntime(threadId: string, change: Partial<ThreadRuntime>): void;
    gitArc: Pick<WorkbenchGitArcFeature, "checkActiveClaimPaths">;
    warn(message: string): void;
  }) {
    const { identities, lookup, projectCatalog, threadState, agentContext, transcript } = ports;
    this.questionnaires = new WorkbenchQuestionnaireController({
      beforeAnswer: async (threadId, signal) => {
        const harness = await lookup.harness(threadId);
        if (harness) await agentContext.collect({ harness, threadId }, "answer", signal);
      },
      ...createWorkbenchQuestionnaireStatePorts({ threads: identities, items: ports.transcriptIdentity }, threadState.controller, async cwd => {
        const resolved = await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Questionnaire" });
        return ProjectIdSchema.parse(resolved.project.id);
      }),
      logError: (message) => {
        console.error("[questionnaire]", message.slice(0, 500));
      },
    });
    const approvalReview = this.approvalReview = new WorkbenchApprovalReviewController({
      database: ports.database,
      readDeviceIdentity,
      readOpenCodeApiKey: () => readOpenCodeApiKey(),
      codexReviewer: () => installedProviderKeys.includes("codex") ? lookup.provider("codex").approvalReview : null,
    });
    const approvals = this.approvals = new WorkbenchApprovalController({
      broadcast: (harness, notification) => ports.context.broadcastProviderNotification(harness, notification),
      collectAnswerContext: async (harness, threadId, signal) => {
        const key = installedProviderKeys.find(candidate => candidate === harness);
        if (key) await agentContext.collect({ harness: key, threadId }, "answer", signal);
      },
      commandApprovals: ports.commandApprovals,
      deliver: async (harness, input) => await lookup.provider(harness).interactions?.deliverApproval(input) ?? false,
      logError: message => { console.error("[approval]", message.slice(0, 500)); },
      observeLifecycle: async (harness, threadId, event) => {
        await threadState.controller.observeLifecycle(harness, threadId, event);
      },
      pendingChanged: threadId => ports.publishRuntime(threadId, { pendingApproval: this.readPendingApproval(threadId) }),
      recordOutcome: async entry => {
        await ports.database.recordApprovalOutcome(entry);
        transcript.acceptApprovalOutcome(entry);
      },
      resolveProject: async threadId => (await identities.resolve({ threadId }))?.projectId ?? null,
      resolveApprovalMode: async threadId => {
        const identity = await identities.resolve({ threadId });
        // Approval modes only exist in daemon projects; normal projects always ask.
        if (!identity || (await projectCatalog.resolveProjectById(identity.projectId)).kind !== "daemon") return DEFAULT_APPROVAL_MODE;
        const states = threadState.controller;
        // Subagents follow the mode of the top-level thread that started their tree.
        let entry = await states.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        for (let depth = 0; entry?.entryKind === "subagent" && depth < 64; depth += 1) {
          entry = await states.getCanonicalThreadEntry(identity.projectId, entry.parentThreadId);
        }
        if (!entry || entry.entryKind === "draft" || entry.entryKind === "subagent") return DEFAULT_APPROVAL_MODE;
        return resolveApprovalMode(await states.readComposerProfileSnapshot({
          kind: "thread", projectId: identity.projectId, harness: entry.identity.harness, threadId: entry.identity.threadId,
        }));
      },
      review: (input, signal) => approvalReview.review(input.subject, signal),
      // Machine claims are approved write permission only in daemon projects; normal projects keep asking.
      coveredByClaims: async (threadId, paths) => {
        const identity = await identities.resolve({ threadId });
        const harness = identity?.bindings[0]?.harness;
        if (!identity || !harness || (await projectCatalog.resolveProjectById(identity.projectId)).kind !== "daemon") return false;
        const absolute = paths.map(candidate => path.resolve(identity.projectRoot, candidate));
        return (await ports.gitArc.checkActiveClaimPaths(identity.projectRoot, WorkbenchHarnessSchema.parse(harness), identity.threadId, absolute)).allowed;
      },
    }, ports.approvalHandoff);
    const questionnaireSteers = this.questionnaireSteers = new WorkbenchQuestionnaireSteerController({
      hasPendingQuestionnaire: async threadId => {
        const entry = await lookup.entry(threadId);
        return Boolean(entry && "pendingQuestionnaire" in entry && entry.pendingQuestionnaire);
      },
      latestTurn: async threadId => {
        const harness = (await lookup.identity(threadId))?.bindings[0]?.harness;
        if (!harness) return null;
        const turn = await lookup.provider(harness).threads.latestTurn(threadId);
        return turn ? { id: turn.id, live: await ports.turnLiveness.read(threadId, harness) } : null;
      },
      readSteers: async threadId => (await ports.transcriptReader.history(threadId)).steerEntries,
      record: transcript.record.bind(transcript),
      now: Date.now,
      warn: ports.warn,
    });
    this.questionnaireResponses = new WorkbenchQuestionnaireResponseController({
      approvals,
      harnesses: ports.harnesses,
      providers: ports.providers,
      questionnaireSteers,
      readSkills: threadId => ports.facts.readThreadSkills(threadId),
      recordSkillActivations: (threadId, paths) => ports.facts.recordUserSkillActivations(threadId, paths),
      resolveLatestTurn: async ({ projectId, threadId }) => {
        const snapshot = await transcript.read({ threadId, turnLimit: 1 });
        if (!snapshot) return null;
        if (snapshot.thread.project_id !== projectId) {
          throw new Error(`Questionnaire thread ${threadId} does not belong to project ${projectId}.`);
        }
        const turnId = snapshot.turns.at(-1)?.id;
        return turnId ? WorkbenchTurnIdSchema.parse(turnId) : null;
      },
      state: threadState.controller,
    });
  }

  /** The thread's shown approval prompt; approvals are live provider facts, never durable thread state. */
  readPendingApproval(threadId: string): ThreadRuntime["pendingApproval"] {
    const request = this.approvals.list().find(candidate => candidate.threadId === threadId);
    return request ? { itemId: request.itemId, request: request.request, requestKey: request.requestKey, turnId: request.turnId } : null;
  }
}

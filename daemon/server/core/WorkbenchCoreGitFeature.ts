/*
 * Exports:
 * - default WorkbenchCoreGitFeature: build Git arcs, thread Git selections, working-tree reads, Git peers and branch positions over shared worktree transitions.
 */
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import GitArcRegistry, { getGitArcLiveClaimPaths } from "../lib/workbench/git/GitArcRegistry";
import type { GitArcThreadIdentityResolver } from "../lib/workbench/git/git-arc-thread-identity";
import type WorkbenchStatsController from "../stats/WorkbenchStatsController";
import type WorkbenchAgentContextController from "../agent/WorkbenchAgentContextController";
import WorkbenchBranchPositionController from "../git/WorkbenchBranchPositionController";
import WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import WorkbenchGitPeerController from "../git/WorkbenchGitPeerController";
import type WorkbenchProjectCatalogController from "../project/WorkbenchProjectCatalogController";
import type WorkbenchSubagentFeature from "../subagents/WorkbenchSubagentFeature";
import WorkbenchThreadGitFeature from "../thread/WorkbenchThreadGitFeature";
import type WorkbenchThreadStateFeature from "../thread/WorkbenchThreadStateFeature";
import WorkbenchWorkingTreeController from "../git/WorkbenchWorkingTreeController";
import type { createWorktreeGitTransitions } from "../git/worktree-git-transitions";
import type { WorkbenchCoreTranscript } from "./WorkbenchTurnRuntimeFeature";

export default class WorkbenchCoreGitFeature {
  readonly gitArc: WorkbenchGitArcFeature;
  readonly threadGit: WorkbenchThreadGitFeature;
  readonly workingTree: WorkbenchWorkingTreeController;
  readonly gitPeer: WorkbenchGitPeerController;
  readonly branchPositions: WorkbenchBranchPositionController;

  constructor(ports: {
    database: DaemonDatabaseRegistration;
    transcript: Pick<WorkbenchCoreTranscript, "read">;
    identities: DaemonRuntimeObjects["threadIdentity"];
    projectCatalog: WorkbenchProjectCatalogController;
    transitions: ReturnType<typeof createWorktreeGitTransitions>;
    agentContext: Pick<WorkbenchAgentContextController, "publish">;
    /** Built after this feature, read at call time. */
    threadState: () => WorkbenchThreadStateFeature | null;
    subagents: () => Pick<WorkbenchSubagentFeature, "resolveGitArcPeer">;
    stats: () => Pick<WorkbenchStatsController, "observeClaimSnapshot"> | null;
    warn(message: string): void;
  }) {
    const { database, identities, projectCatalog, transitions, warn } = ports;
    const requireThreadState = (purpose: string) => {
      const state = ports.threadState();
      if (!state) throw new Error(`Thread state is not ready for Git arc ${purpose}.`);
      return state.controller;
    };
    const gitArc = this.gitArc = new WorkbenchGitArcFeature({
      identities,
      legacyDiffStore: database,
      proposalDiffStore: {
        read: async identity => await database.readGitArcProposalDiff(identity),
        write: async (value, maxBytes) => await database.writeGitArcProposalDiff(value, maxBytes),
      },
      // Without permanent history facts a lifecycle read publishes every accepted proposal: slower, never missing one.
      readDurableProposalIds: async threadIds => {
        const state = ports.threadState();
        if (!state) return new Map();
        try { return await state.controller.readDurableProposalIds(threadIds); }
        catch (error) {
          warn(`Durable proposal read failed: ${error instanceof Error ? error.message : "unknown failure"}`);
          return new Map();
        }
      },
      getThreadCreatedAt: async (projectId, _harness, threadId) => {
        const snapshot = await ports.transcript.read({ threadId, turnLimit: 1 });
        if (!snapshot) return null;
        if (snapshot.thread.project_id !== projectId) {
          throw new Error(`Managed thread ${threadId} does not belong to project ${projectId}.`);
        }
        return snapshot.thread.created_at;
      },
      getThreadClaimContext: async (projectId, harness, threadId) => (
        await requireThreadState("ownership").getThreadClaimContext(projectId, harness, threadId)
      ),
      publishGitArcAcceptance: async (projectId, harness, threadId, acceptance) => {
        await requireThreadState("publication").publishGitArcAcceptance(projectId, harness, threadId, acceptance);
      },
      refreshThreadGitArcState: async (projectId, harness, threadId) => {
        await requireThreadState("publication").refreshGitArcState(projectId, harness, threadId);
      },
      publishAgentContext: (target, text) => ports.agentContext.publish(target, text),
      resolveSubagentPeer: input => ports.subagents().resolveGitArcPeer(input),
      observeClaimSnapshot: (snapshot) => ports.stats()?.observeClaimSnapshot(snapshot),
      listCatalogProjects: async () => (await projectCatalog.readCatalog()).data,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" }),
      transitions,
    });
    const resolveGitArcIdentity: GitArcThreadIdentityResolver = async input => await gitArc.resolveThreadIdentity(input);
    this.threadGit = new WorkbenchThreadGitFeature({
      selectionStore: database,
      identities,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" }),
      transitions,
      integrations: {
        listClaims: async repository => (await new GitArcRegistry(repository, resolveGitArcIdentity).list())
          .map(entry => ({ threadId: entry.threadId, paths: getGitArcLiveClaimPaths(entry) })),
        waitForClaims: (attempt, signal) => gitArc.waitForClaimChanges(attempt, signal),
      },
    });
    this.workingTree = new WorkbenchWorkingTreeController({
      resolveProject: projectId => projectCatalog.resolveProjectById(projectId),
      resolveIdentity: resolveGitArcIdentity,
      readOwner: async (threadId, harness) => {
        const identity = await identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
        if (!identity) return null;
        const entry = await requireThreadState("ownership").getThreadEntry(identity.projectId, WorkbenchHarnessSchema.parse(harness), identity.threadId);
        return entry ? { id: identity.threadId, projectId: identity.projectId, entry } : null;
      },
      transitions,
    });
    const resolveCheckoutRoot = async (projectId: string) => (await projectCatalog.resolveProjectById(projectId)).rootPath;
    this.gitPeer = new WorkbenchGitPeerController({ resolveRoot: resolveCheckoutRoot, transitions, warn });
    this.branchPositions = new WorkbenchBranchPositionController({ resolveRoot: resolveCheckoutRoot, warn });
  }
}

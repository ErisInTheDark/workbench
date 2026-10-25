/*
 * Exports:
 * - default WorkbenchCoreGitFeature: build Git arcs (machine claims approved through the thread's approval mode), thread Git
 *   selections, working-tree reads, Git peers, branch positions with upstream fetches, and checkout object reads, ref
 *   moves and upstream pulls over shared worktree transitions.
 */
import { ProjectIdSchema, ThreadReferenceSchema, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { DaemonDatabaseRegistration, DaemonRuntimeObjects } from "../daemon-runtime-objects";
import { projectRoot } from "../lib/project-root";
import GitArcRegistry, { getGitArcLiveClaimPaths } from "../lib/workbench/git/GitArcRegistry";
import type { GitArcThreadIdentityResolver } from "../lib/workbench/git/git-arc-thread-identity";
import type WorkbenchStatsController from "../stats/WorkbenchStatsController";
import type WorkbenchAgentContextController from "../agent/WorkbenchAgentContextController";
import type WorkbenchApprovalController from "../interactions/WorkbenchApprovalController";
import WorkbenchBranchPositionController from "../git/WorkbenchBranchPositionController";
import WorkbenchGitArcFeature from "../git/WorkbenchGitArcFeature";
import WorkbenchGitCheckoutController from "../git/WorkbenchGitCheckoutController";
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
  readonly gitCheckout: WorkbenchGitCheckoutController;

  constructor(ports: {
    database: DaemonDatabaseRegistration;
    transcript: Pick<WorkbenchCoreTranscript, "read">;
    identities: DaemonRuntimeObjects["threadIdentity"];
    projectCatalog: WorkbenchProjectCatalogController;
    transitions: ReturnType<typeof createWorktreeGitTransitions>;
    agentContext: Pick<WorkbenchAgentContextController, "publish">;
    /** Built after this feature, read at call time. */
    threadState: () => WorkbenchThreadStateFeature | null;
    /**
     * Runs on the live generation's thread state, so a mutation that finishes during a reload publishes into the
     * replacement instead of its retired database.
     */
    publishThreadState(operation: (state: WorkbenchThreadStateFeature) => Promise<void>): Promise<void>;
    subagents: () => Pick<WorkbenchSubagentFeature, "resolveGitArcPeer">;
    stats: () => Pick<WorkbenchStatsController, "observeClaimSnapshot"> | null;
    /** Built after this feature, read at call time; decides new machine claims through the thread's approval mode. */
    approvals: () => Pick<WorkbenchApprovalController, "request">;
    /** The thread's in-progress turn, so a claim approval sits on the turn that asked for it. */
    activeTurn(threadId: WorkbenchThreadId, harness: WorkbenchHarness): Promise<WorkbenchTurnId | null>;
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
        await ports.publishThreadState(async state => {
          await state.controller.publishGitArcAcceptance(projectId, harness, threadId, acceptance);
        });
      },
      refreshThreadGitArcState: async (projectId, harness, threadId) => {
        await ports.publishThreadState(async state => {
          await state.controller.refreshGitArcState(projectId, harness, threadId);
        });
      },
      publishAgentContext: (target, text) => ports.agentContext.publish(target, text),
      resolveSubagentPeer: input => ports.subagents().resolveGitArcPeer(input),
      observeClaimSnapshot: (snapshot) => ports.stats()?.observeClaimSnapshot(snapshot),
      listCatalogProjects: async () => (await projectCatalog.readCatalog()).data,
      resolveProjectFromCwd: async (cwd) => await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Git arc" }),
      approveMachineClaims: async (request, signal) => await ports.approvals().request({
        ...request, turnId: request.turnId ?? await ports.activeTurn(request.threadId, request.harness),
      }, signal),
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
    const readOwner = async (threadId: string, harness: string) => {
      const identity = await identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
      if (!identity) return null;
      const entry = await requireThreadState("ownership").getThreadEntry(identity.projectId, WorkbenchHarnessSchema.parse(harness), identity.threadId);
      return entry ? { id: identity.threadId, projectId: identity.projectId, entry } : null;
    };
    this.workingTree = new WorkbenchWorkingTreeController({
      resolveProject: projectId => projectCatalog.resolveProjectById(projectId),
      resolveIdentity: resolveGitArcIdentity,
      readOwner,
      transitions,
    });
    const resolveCheckoutRoot = async (projectId: string) => (await projectCatalog.resolveProjectById(projectId)).rootPath;
    this.gitPeer = new WorkbenchGitPeerController({ resolveRoot: resolveCheckoutRoot, transitions, warn });
    // The installation updater already fetches the running checkout on its own schedule.
    const branchPositions = new WorkbenchBranchPositionController({
      resolveRoot: resolveCheckoutRoot, backgroundFetchedElsewhere: [projectRoot], warn,
    });
    this.branchPositions = branchPositions;
    this.gitCheckout = new WorkbenchGitCheckoutController({
      resolveRoot: resolveCheckoutRoot,
      fetchUpstream: async projectId => await branchPositions.fetch(projectId),
      resolveIdentity: resolveGitArcIdentity,
      readOwner,
      transitions,
      discoverProject: async rootPath => await projectCatalog.discoverCreatedProject(rootPath),
      commitThreads: async (projectId, sha) => {
        const owners = [];
        for (const threadId of await database.findThreadGitCommitOwners(ProjectIdSchema.parse(projectId), sha)) {
          const identity = await identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
          const harness = identity?.bindings[0]?.harness;
          const owner = harness ? await readOwner(threadId, harness) : null;
          if (owner) owners.push(owner);
        }
        return owners;
      },
    });
  }
}

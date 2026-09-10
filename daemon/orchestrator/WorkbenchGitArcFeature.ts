/*
 * Exports:
 * - WorkbenchGitArcFeatureOptions: project resolution, canonical thread callbacks, and stable transition ports.
 * - WorkbenchGitArcLifecycleState: public lifecycle with canonical owner and member identities.
 * - WorkbenchGitArcPlanState: public plan with canonical owner and member identities.
 * - WorkbenchGitArcActiveClaim: public claim with a canonical thread owner.
 * - default WorkbenchGitArcFeature: own Git arc dispatch and native registry identity conversion.
 */
import type http from "node:http";

import WorkbenchGitCheckpointController, { type GitArcActiveClaim } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import GitClaimHistoryReader from "../lib/workbench/git/GitClaimHistoryReader";
import { GitArcAcceptedProposalsError } from "../lib/workbench/git/GitArcProposalController";
import {
  createGitArcOperationRejected,
  createGitArcFailureFromError,
  formatGitArcFailureText,
  GitArcFailureException,
  GitArcMissingClaimSetError,
  GitArcProposalAlreadyCommittedError,
  type GitArcFailure,
} from "workbench-shared/workbench/git/git-arc-failures";
import { GitCheckpointDirtyPathsError, GitCheckpointIgnoredPathsError } from "../lib/workbench/git/GitArcPlanController";
import { GitArcStartDiagnosticError } from "../lib/workbench/git/git-arc-start-diagnostics";
import { GitArcCollisionError } from "../lib/workbench/git/GitArcRegistry";
import { GitCheckpointMissingObjectError } from "../lib/workbench/git/GitCheckpointStore";
import type { WorkbenchHarness } from "workbench-shared/types";
import { GitCheckpointRequestSchema, type GitCheckpointRequest } from "workbench-shared/workbench/git/checkpoint-contracts";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type { WorkbenchThreadClaimContext } from "./WorkbenchThreadStateController";
import type { WorkbenchGitClaimSnapshot } from "./stats/git-claim-observation";
import WorkbenchWorkspaceGitArcController, { WorkspaceGitArcMemberError, type WorkspaceGitArcLifecycleState, type WorkspaceGitArcPlanState } from "./WorkbenchWorkspaceGitArcController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import { ProjectIdSchema, ThreadReferenceSchema, type ProjectId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface WorkbenchGitArcFeatureOptions {
  identities: WorkbenchThreadIdentityController;
  getReloadScopesForPaths?(paths: readonly string[]): string[];
  getThreadCreatedAt(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<number | null>;
  getThreadClaimContext(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchThreadClaimContext | null>;
  refreshThreadGitArcState(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<void>;
  onReloadEligibilityChanged?: () => void;
  observeClaimSnapshot?(snapshot: WorkbenchGitClaimSnapshot): void;
  reloadScopeProjectRoot?: string;
  resolveProjectFromCwd(cwd: string): Promise<AgentEndpointProjectResolution | { cwd: string; project: { id: ProjectId } }>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">
    & Partial<Pick<WorkbenchThreadTransitionCoordinator, "read" | "readMany" | "runMany">>;
}

type PublicGitOwner<T extends { threadId: string }> = Omit<T, "threadId"> & { threadId: WorkbenchThreadId };
type PublicGitState<T extends { threadId: string; members: Array<{ threadId: string }> }> =
  Omit<T, "threadId" | "members"> & {
    threadId: WorkbenchThreadId;
    members: Array<PublicGitOwner<T["members"][number]>>;
  };
export type WorkbenchGitArcLifecycleState = PublicGitState<WorkspaceGitArcLifecycleState>;
export type WorkbenchGitArcPlanState = PublicGitState<WorkspaceGitArcPlanState>;
export type WorkbenchGitArcActiveClaim = PublicGitOwner<GitArcActiveClaim>;

const GIT_ARC_STATE_MUTATION_ACTIONS = new Set<GitCheckpointRequest["action"]>([
  "planClaims", "arcClaims",
  "arcAdd", "arcAdopt", "arcContinue", "arcMove", "arcRelease", "arcRemove", "arcStart", "plan", "planAdd", "planAdopt", "planRemove", "planStart",
  "proposalCommit", "proposalCreate", "proposalRescind", "restore",
]);
const COALESCED_CARD_READ_ACTIONS = new Set<GitCheckpointRequest["action"]>(["compare", "proposalState"]);
const CLAIM_START_ACTIONS = new Set<GitCheckpointRequest["action"]>(["arcContinue", "arcStart", "planStart"]);

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
}

function findIgnoredPathsError(error: unknown) {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof GitCheckpointIgnoredPathsError) return current;
    seen.add(current);
    current = current.cause;
  }
  return null;
}

function failureResponse(failure: GitArcFailure) {
  return Response.json({
    error: formatGitArcFailureText(failure),
    gitArcFailure: failure,
  }, { status: 400 });
}

function liveCollisionOwner(entry: GitArcCollisionError["collisions"][number]["entry"]) {
  return entry.phase === "plan" && entry.retainedArc ? entry.retainedArc : entry;
}

function mutatesGitArcState(request: GitCheckpointRequest) {
  return GIT_ARC_STATE_MUTATION_ACTIONS.has(request.action)
    && !(request.action === "arcMove" && request.move.kind === "regex" && !request.move.confirm);
}

function requireInspectionModifiedSince(value: number | undefined) {
  if (value === undefined) throw new Error("Git arc inspection requires the managed thread creation timestamp.");
  return value;
}

function usesWorkspaceController(project: AgentEndpointProjectResolution, request: GitCheckpointRequest) {
  if (project.project.roots.length > 1) return true;
  if ("roots" in request && request.roots.length) return true;
  if ("refs" in request && request.refs.length) return true;
  return "rootId" in request && Boolean(request.rootId);
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench Git arc request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sendResponse(response: http.ServerResponse, upstream: Response) {
  response.statusCode = upstream.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

export default class WorkbenchGitArcFeature {
  private readonly claimHistory = new GitClaimHistoryReader();
  private readonly controller = new WorkbenchGitCheckpointController();
  private readonly disposal = new AbortController();
  private readonly workspaceController: WorkbenchWorkspaceGitArcController;
  private readonly pendingCardReads = new Map<string, Promise<Response>>();
  private claimRevision = 0;
  private readonly claimWaiters = new Set<() => void>();

  constructor(private readonly options: WorkbenchGitArcFeatureOptions) {
    const readMany = options.transitions.readMany ?? options.transitions.runMany;
    this.workspaceController = new WorkbenchWorkspaceGitArcController(this.controller, {
      readMany: async (paths, operation) => readMany
        ? await readMany.call(options.transitions, paths, operation)
        : await options.transitions.run(paths[0] ?? "git-arc", operation),
      runMany: async (paths, operation) => options.transitions.runMany
        ? await options.transitions.runMany(paths, operation)
        : await options.transitions.run(paths[0] ?? "git-arc", operation),
    }, undefined, (snapshot) => this.options.observeClaimSnapshot?.(snapshot), this.claimHistory);
  }

  private async resolveProject(cwd: string): Promise<AgentEndpointProjectResolution> {
    const resolved = await this.options.resolveProjectFromCwd(cwd);
    if ("root" in resolved && "roots" in resolved.project) return resolved;
    const root = { id: resolved.project.id, name: resolved.project.id, root: resolved.cwd, rootPath: resolved.cwd };
    return {
      cwd: resolved.cwd,
      project: { id: resolved.project.id, kind: "git", root: resolved.cwd, rootPath: resolved.cwd, roots: [root] },
      root,
    };
  }

  async findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchGitArcActiveClaim | null> {
    const project = await this.resolveProject(cwd);
    const native = await this.nativeThreadIdentity(project.project.id, harness, threadId);
    const claim = await this.controller.findActiveClaim({ cwd, ...native });
    return claim
      ? { ...claim, threadId: await this.publicThreadId(project.project.id, harness, claim.threadId) }
      : null;
  }

  async checkActiveClaimPaths(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId, paths: readonly string[]) {
    const project = await this.resolveProject(cwd);
    const native = await this.nativeThreadIdentity(project.project.id, harness, threadId);
    return await this.workspaceController.checkActiveClaimPaths(project, native.harness, native.threadId, paths);
  }

  async listActiveClaims(cwd: string): Promise<WorkbenchGitArcActiveClaim[]> {
    const project = await this.resolveProject(cwd);
    const claims = await this.controller.listActiveClaims({ cwd });
    return await Promise.all(claims.map(async claim => ({
      ...claim, threadId: await this.publicThreadId(project.project.id, WorkbenchHarnessSchema.parse(claim.harness), claim.threadId),
    })));
  }

  async listReloadScopeClaims(_cwd: string) {
    return [];
  }

  async pruneThreadHistories(cwd: string, identities: ReadonlyArray<{ harness: WorkbenchHarness; threadId: WorkbenchThreadId }>) {
    if (!identities.length) return { prunedRefCount: 0, registryEntryRemoved: false };
    const project = await this.resolveProject(cwd);
    const native = await Promise.all(identities.map(identity => (
      this.nativeThreadIdentity(project.project.id, identity.harness, identity.threadId)
    )));
    return await this.workspaceController.pruneThreadHistories(project, native);
  }

  async findLifecycleState(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchGitArcLifecycleState | null> {
    const project = await this.resolveProject(cwd);
    const native = await this.nativeThreadIdentity(project.project.id, harness, threadId);
    const state = await this.workspaceController.findLifecycleState(project, native.harness, native.threadId);
    return state ? await this.publicState(project.project.id, state) : null;
  }

  async discoverClaimHistory(input: { projectId: string; rootId: string; workspaceRoot: string }) {
    return await this.claimHistory.discover(input);
  }

  async hydrateClaimHistory(candidate: import("./database/stats/WorkbenchStatsImportRepository").WorkbenchGitClaimImportCandidate) {
    return await this.claimHistory.hydrate(candidate);
  }

  async hasLiveClaims(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
    const project = await this.resolveProject(cwd);
    const native = await this.nativeThreadIdentity(project.project.id, harness, threadId);
    return await this.workspaceController.hasLiveClaims(project, native.harness, native.threadId);
  }

  async listLifecycleStates(cwd: string): Promise<WorkbenchGitArcLifecycleState[]> {
    const project = await this.resolveProject(cwd);
    return await Promise.all((await this.workspaceController.listLifecycleStates(project)).map(state => (
      this.publicState(project.project.id, state)
    )));
  }

  async reconcileClaimSnapshots(cwd: string) {
    if (!this.options.observeClaimSnapshot) return;
    const project = await this.resolveProject(cwd);
    const observedAt = Date.now();
    for (const state of await this.workspaceController.listLifecycleStates(project)) {
      this.emitClaimSnapshot(project, state.harness as WorkbenchHarness, state.threadId, state, observedAt);
    }
  }

  async findPlanState(cwd: string, harness: WorkbenchHarness, threadId: WorkbenchThreadId): Promise<WorkbenchGitArcPlanState | null> {
    const project = await this.resolveProject(cwd);
    const native = await this.nativeThreadIdentity(project.project.id, harness, threadId);
    const state = await this.workspaceController.findPlanState(project, native.harness, native.threadId);
    return state ? await this.publicState(project.project.id, state) : null;
  }

  async listPlanStates(cwd: string): Promise<WorkbenchGitArcPlanState[]> {
    const project = await this.resolveProject(cwd);
    return await Promise.all((await this.workspaceController.listPlanStates(project)).map(state => (
      this.publicState(project.project.id, state)
    )));
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      await sendResponse(response, await this.executeRequest(JSON.parse(await readBody(request)) as object));
    } catch (error) {
      await sendResponse(response, failureResponse(createGitArcOperationRejected(
        "unknown",
        error instanceof Error ? error.message : "Invalid Git arc request.",
      )));
    }
  }

  async executeRequest(input: object, signal?: AbortSignal) {
    const parsed = GitCheckpointRequestSchema.safeParse(input);
    if (!parsed.success) return failureResponse(createGitArcFailureFromError("unknown", parsed.error));
    try {
      const project = await this.resolveProject(parsed.data.cwd);
      const identity = await this.options.identities.resolve({
        threadId: ThreadReferenceSchema.parse(parsed.data.threadId), projectId: ProjectIdSchema.parse(project.project.id), harness: parsed.data.harness,
      });
      if (!identity?.bindings[0]) throw new Error("The managed thread has no native Git arc identity.");
      const binding = identity.bindings[0];
      const request = {
        ...parsed.data, cwd: project.cwd,
        harness: WorkbenchHarnessSchema.parse(binding.harness), threadId: binding.nativeThreadId,
      };
      const owner = { harness: request.harness, threadId: identity.threadId };
      const modifiedSince = request.action === "compare" || request.action === "diff"
        ? await this.options.getThreadCreatedAt(project.project.id, owner.harness, owner.threadId)
        : null;
      if ((request.action === "compare" || request.action === "diff") && modifiedSince === null) {
        throw new Error("The managed thread creation timestamp is unavailable for Git arc inspection.");
      }
      if (request.action === "arcWait") {
        try {
          return Response.json(await this.waitForPlanAndStart(project, request, owner, signal));
        } catch (error) {
          throw new GitArcFailureException(await this.createFailure(project.project.id, request, error));
        }
      }
      if (mutatesGitArcState(request)) this.fencePendingCardReads(project.cwd);
      const execute = async () => {
        try {
          if (CLAIM_START_ACTIONS.has(request.action)) {
            const before = await this.options.getThreadClaimContext(project.project.id, owner.harness, owner.threadId);
            if (!before) throw new Error("The managed thread is not available for Git arc ownership.");
            if (before.lifecycle.settled) throw new Error("A settled thread cannot start or continue a Git arc.");
          }
          let response: Response;
          try {
            response = request.action === "readDiffArtifact"
              ? await this.dispatch(request)
              : usesWorkspaceController(project, request)
                ? Response.json(await this.workspaceController.execute(project, request, { modifiedSince: modifiedSince ?? undefined }))
                : mutatesGitArcState(request)
                  ? await this.options.transitions.run(project.cwd, async () => {
                    try {
                      return await this.dispatch(request);
                    } finally {
                      await this.observeLocalClaimSnapshot(project, request.harness, request.threadId);
                    }
                  })
                  : await (this.options.transitions.read ?? this.options.transitions.run)
                    .call(this.options.transitions, project.cwd, async () => await this.dispatch(request, modifiedSince ?? undefined));
          } catch (error) {
            throw new GitArcFailureException(await this.createFailure(project.project.id, request, error));
          }
          if (response.ok && CLAIM_START_ACTIONS.has(request.action)) {
            const after = await this.options.getThreadClaimContext(project.project.id, owner.harness, owner.threadId);
            if (after?.lifecycle.settled) {
              await this.workspaceController.releaseActiveClaim(project, request.harness, request.threadId);
              throw new Error("The thread settled while its Git arc claim was starting. The new claim was released.");
            }
          }
          return response;
        } finally {
          if (mutatesGitArcState(request)) {
            this.notifyClaimMutation();
            await this.refreshThreadGitArcState(project.project.id, owner.harness, owner.threadId);
          }
        }
      };
      if (!COALESCED_CARD_READ_ACTIONS.has(request.action)) return await execute();
      return await this.coalesceCardRead(project.cwd, request, execute);
    } catch (error) {
      const failure = error instanceof GitArcFailureException
        ? error.failure
        : createGitArcFailureFromError(parsed.data.action, error);
      return failureResponse(failure);
    }
  }

  private async waitForPlanAndStart(
    project: AgentEndpointProjectResolution,
    request: Extract<GitCheckpointRequest, { action: "arcWait" }>,
    owner: { harness: WorkbenchHarness; threadId: WorkbenchThreadId },
    callerSignal?: AbortSignal,
  ) {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.disposal.signal])
      : this.disposal.signal;
    while (true) {
      signal.throwIfAborted();
      const revision = this.claimRevision;
      const attempt = await this.tryStartWaitingPlan(project, request, owner, signal);
      if (attempt.kind === "started") return attempt.result;
      await this.waitForClaimMutation(revision, signal);
    }
  }

  private async tryStartWaitingPlan(
    project: AgentEndpointProjectResolution,
    request: Extract<GitCheckpointRequest, { action: "arcWait" }>,
    owner: { harness: WorkbenchHarness; threadId: WorkbenchThreadId },
    signal: AbortSignal,
  ) {
    const before = await this.options.getThreadClaimContext(project.project.id, owner.harness, owner.threadId);
    if (!before) throw new Error("The managed thread is not available for Git arc ownership.");
    if (before.lifecycle.settled) throw new Error("A settled thread cannot start or continue a Git arc.");

    let mutationStarted = false;
    const beforeStart = () => {
      mutationStarted = true;
      this.fencePendingCardReads(project.cwd);
    };
    try {
      const attempt = usesWorkspaceController(project, request)
        ? await this.workspaceController.tryStartWaitingArc(project, request, {
          beforeStart,
          throwIfAborted: () => signal.throwIfAborted(),
        })
        : await this.options.transitions.run(project.cwd, async () => {
          signal.throwIfAborted();
          const collisions = await this.controller.findPlanClaimCollisions({
            checkpointCommit: request.checkpointCommit,
            cwd: project.cwd,
            harness: request.harness,
            threadId: request.threadId,
          });
          if (collisions.collisions.length) return { kind: "blocked" as const };
          signal.throwIfAborted();
          beforeStart();
          try {
            const result = {
              kind: "started" as const,
              result: await this.controller.startArc({
                checkpointCommit: request.checkpointCommit,
                cwd: project.cwd,
                harness: request.harness,
                threadId: request.threadId,
              }),
            };
            await this.observeLocalClaimSnapshot(project, request.harness, request.threadId);
            return result;
          } catch (error) {
            if (error instanceof GitArcCollisionError) {
              mutationStarted = false;
              return { kind: "blocked" as const };
            }
            throw error;
          }
        });
      if (attempt.kind === "blocked") return attempt;

      const after = await this.options.getThreadClaimContext(project.project.id, owner.harness, owner.threadId);
      if (after?.lifecycle.settled) {
        await this.workspaceController.releaseActiveClaim(project, request.harness, request.threadId);
        throw new Error("The thread settled while its Git arc claim was starting. The new claim was released.");
      }
      return attempt;
    } finally {
      if (mutationStarted) {
        this.notifyClaimMutation();
        await this.refreshThreadGitArcState(project.project.id, owner.harness, owner.threadId);
      }
    }
  }

  private async waitForClaimMutation(revision: number, signal: AbortSignal) {
    if (revision !== this.claimRevision) return;
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        this.claimWaiters.delete(wake);
        signal.removeEventListener("abort", abort);
        error === undefined ? resolve() : reject(error);
      };
      const wake = () => finish();
      const abort = () => finish(signal.reason ?? new Error("Git arc wait was interrupted."));
      this.claimWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
      if (revision !== this.claimRevision) wake();
      else if (signal.aborted) abort();
    });
  }

  private notifyClaimMutation() {
    this.claimRevision += 1;
    for (const wake of [...this.claimWaiters]) wake();
  }

  dispose() {
    this.disposal.abort(new Error("Git arc feature disposed."));
    this.notifyClaimMutation();
  }

  private async coalesceCardRead(cwd: string, request: GitCheckpointRequest, execute: () => Promise<Response>) {
    const key = `${cwd}\0${JSON.stringify(request)}`;
    const existing = this.pendingCardReads.get(key);
    if (existing) return (await existing).clone();
    const pending = execute().finally(() => {
      if (this.pendingCardReads.get(key) === pending) this.pendingCardReads.delete(key);
    });
    this.pendingCardReads.set(key, pending);
    return (await pending).clone();
  }

  private fencePendingCardReads(cwd: string) {
    const prefix = `${cwd}\0`;
    for (const key of this.pendingCardReads.keys()) {
      if (key.startsWith(prefix)) this.pendingCardReads.delete(key);
    }
  }

  private async createFailure(projectId: ProjectId, request: GitCheckpointRequest, error: unknown): Promise<GitArcFailure> {
    if (error instanceof WorkspaceGitArcMemberError) {
      return {
        ...await this.createFailure(projectId, request, error.cause),
        workspace: {
          failedRootIds: error.workspace.failedRootIds.slice(0, 20),
          completedRootIds: error.workspace.completedRootIds.slice(0, 20),
          stage: error.workspace.stage,
        },
      };
    }
    if (error instanceof GitArcAcceptedProposalsError) {
      return {
        action: request.action,
        claimedPaths: error.claimedPaths.slice(0, 20),
        code: "acceptedProposals",
        proposals: error.receipts.slice(0, 20),
        version: 1,
      };
    }
    if (error instanceof GitArcMissingClaimSetError) {
      return {
        action: request.action,
        code: "missingClaimSet",
        version: 1,
      };
    }
    if (error instanceof GitArcProposalAlreadyCommittedError) {
      return {
        action: request.action,
        code: "proposalAlreadyCommitted",
        commitSha: error.commitSha,
        proposalId: error.proposalId,
        proposalTitle: error.proposalTitle,
        version: 1,
      };
    }
    if (error instanceof GitCheckpointMissingObjectError) {
      return {
        action: request.action,
        code: "missingArcRef",
        ref: error.requestedRef,
        version: 1,
      };
    }
    if (error instanceof GitCheckpointDirtyPathsError) {
      return {
        action: request.action,
        code: "dirtyPaths",
        paths: error.dirtyPaths.slice(0, 20),
        version: 1,
      };
    }
    const ignoredPathsError = findIgnoredPathsError(error);
    if (ignoredPathsError) {
      return {
        action: request.action,
        code: "ignoredPaths",
        paths: ignoredPathsError.ignoredPaths.slice(0, 20),
        version: 1,
      };
    }
    const collisions = error instanceof GitArcCollisionError
      ? error.collisions
      : error instanceof GitArcStartDiagnosticError ? error.details.collisions : [];
    const conflicts = await Promise.all(collisions.slice(0, 8).map(async (collision) => {
      const harness = WorkbenchHarnessSchema.parse(collision.entry.harness);
      const threadId = await this.publicThreadId(projectId, harness, collision.entry.threadId);
      const ownerContext = await this.options.getThreadClaimContext(
        projectId,
        harness,
        threadId,
      );
      const owner = liveCollisionOwner(collision.entry);
      return {
        overlaps: collision.overlaps.slice(0, 20),
        owner: {
          checkpointCommit: owner.checkpointCommit,
          harness: collision.entry.harness,
          intentName: owner.intentName,
          lifecycle: ownerContext?.lifecycle.kind ?? "unknown",
          threadId,
          title: ownerContext?.title.trim() || owner.intentName,
        },
      };
    }));
    if (error instanceof GitArcCollisionError || (error instanceof GitArcStartDiagnosticError
      && !error.details.snapshotDrift.length && error.details.headMovement !== "incompatible" && conflicts.length)) {
      return {
        action: request.action,
        code: "siblingClaimCollision",
        conflicts,
        version: 1,
      };
    }
    if (error instanceof GitArcStartDiagnosticError) {
      return {
        action: request.action,
        code: "planDrift",
        commits: error.details.commitChanges.slice(0, 8).map(({ changedPaths, commit, subject }) => ({
          commit,
          paths: changedPaths.slice(0, 20),
          subject,
        })),
        conflicts,
        dirtyPaths: error.details.dirtyUnclaimedPaths.slice(0, 20),
        headMovement: error.details.headMovement === "fast-forward" ? "fastForward" : error.details.headMovement,
        planRef: error.details.planCheckpointCommit,
        snapshotPaths: error.details.snapshotDrift.slice(0, 20),
        version: 1,
      };
    }
    return createGitArcFailureFromError(request.action, error);
  }

  private async refreshThreadGitArcState(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
    try {
      await this.options.refreshThreadGitArcState(projectId, harness, threadId);
    } catch (error) {
      console.error(`Git arc state refresh failed after a mutation attempt: ${sanitizeError(error)}`);
    }
  }

  private async observeLocalClaimSnapshot(
    project: AgentEndpointProjectResolution,
    harness: WorkbenchHarness,
    threadId: string,
  ) {
    if (!this.options.observeClaimSnapshot) return;
    try {
      const state = await this.workspaceController.findLifecycleState(project, harness, threadId);
      const updatedAt = state ? Date.parse(state.updatedAt) : Number.NaN;
      this.emitClaimSnapshot(project, harness, threadId, state, Number.isFinite(updatedAt) ? updatedAt : Date.now());
    } catch (error) {
      console.error(`Git claim observation failed after a mutation: ${sanitizeError(error)}`);
    }
  }

  private emitClaimSnapshot(
    project: AgentEndpointProjectResolution,
    harness: WorkbenchHarness,
    threadId: string,
    state: WorkspaceGitArcLifecycleState | null,
    observedAt: number,
  ) {
    const paths = state?.claimedPaths ?? [];
    this.options.observeClaimSnapshot?.({
      harness,
      observedAt,
      projectId: project.project.id,
      roots: project.project.roots.map((root) => ({
        paths: project.project.roots.length === 1
          ? paths
          : paths.flatMap((candidate) => {
            const prefix = `${root.id}:`;
            return candidate.startsWith(prefix) ? [candidate.slice(prefix.length) || "."] : [];
          }),
        rootId: root.id,
      })),
      threadId,
    });
  }

  private async publicThreadId(projectId: ProjectId, harness: WorkbenchHarness, threadId: string) {
    const identity = await this.options.identities.resolve({
      projectId: ProjectIdSchema.parse(projectId), harness, threadId: ThreadReferenceSchema.parse(threadId),
    });
    if (!identity) throw new Error("Git arc owner metadata is unavailable for public projection.");
    return identity.threadId;
  }

  private async nativeThreadIdentity(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
    const identity = await this.options.identities.resolve({
      projectId: ProjectIdSchema.parse(projectId), harness, threadId: ThreadReferenceSchema.parse(threadId),
    });
    const binding = identity?.bindings.find(binding => binding.harness === harness);
    if (!binding) throw new Error("The managed thread has no native Git arc identity.");
    return { harness, threadId: binding.nativeThreadId };
  }

  private async publicState<T extends WorkspaceGitArcLifecycleState | WorkspaceGitArcPlanState>(projectId: ProjectId, state: T): Promise<PublicGitState<T>> {
    return {
      ...state,
      threadId: await this.publicThreadId(projectId, WorkbenchHarnessSchema.parse(state.harness), state.threadId),
      members: await Promise.all(state.members.map(async member => ({
        ...member,
        threadId: await this.publicThreadId(projectId, WorkbenchHarnessSchema.parse(member.harness), member.threadId),
      }))),
    };
  }

  private async dispatch(input: GitCheckpointRequest, modifiedSince?: number) {
    const common = { cwd: input.cwd, harness: input.harness, threadId: input.threadId };
    switch (input.action) {
      case "planClaims": return Response.json(await this.controller.editPlanClaims({ ...common, ...input }));
      case "arcClaims": return Response.json(await this.controller.editArcClaims({ ...common, ...input }));
      case "arcScope": return Response.json(await this.controller.readScope(common));
      case "plan": return Response.json(await this.controller.createPlan({
        ...common, adoptPaths: input.adoptPaths, intentDescription: input.intentDescription, intentName: input.intentName, paths: input.paths,
      }));
      case "planAdd": return Response.json(await this.controller.addToPlan({ ...common, paths: input.paths }));
      case "planAdopt": return Response.json(await this.controller.adoptIntoPlan({ ...common, paths: input.paths }));
      case "planRemove": return Response.json(await this.controller.removeFromPlan({ ...common, paths: input.paths }));
      case "planStart": return Response.json(await this.controller.createAndStartPlan({
        ...common, adoptPaths: input.adoptPaths, intentDescription: input.intentDescription, intentName: input.intentName, paths: input.paths,
      }));
      case "arcStart": return Response.json(await this.controller.startArc({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcWait": return Response.json(await this.controller.findPlanClaimCollisions({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcContinue": return Response.json(await this.controller.continueArc({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcAdd": return Response.json(await this.controller.addToArc({ ...common, paths: input.paths }));
      case "arcAdopt": return Response.json(await this.controller.adoptIntoArc({ ...common, paths: input.paths }));
      case "arcMove": return Response.json(await this.controller.moveInArc({ ...common, move: input.move }));
      case "arcRemove": return Response.json(await this.controller.removeFromArc({ ...common, paths: input.paths }));
      case "arcRelease": return Response.json(await this.controller.releaseArc({ ...common, disown: input.disown }));
      case "compare": {
        const inspection = await this.controller.createInspectionSnapshot(input.cwd);
        const [result, unclaimedDirtPaths] = await Promise.all([
          this.controller.compare({
            ...common, ...(input.paths ? { paths: input.paths } : {}), ...(input.ref ? { ref: input.ref } : {}),
          }, inspection),
          this.controller.listUnclaimedWorkspaceDirt({
            cwd: input.cwd,
            modifiedSince: requireInspectionModifiedSince(modifiedSince),
          }, inspection),
        ]);
        return Response.json({ ...result, unclaimedDirtPaths });
      }
      case "diff": {
        const inspection = await this.controller.createInspectionSnapshot(input.cwd);
        const [result, unclaimedDirtPaths] = await Promise.all([
          this.controller.diff({
            ...common,
            ...(input.page !== undefined ? { page: input.page } : {}),
            ...(input.paths ? { paths: input.paths } : {}),
            ...(input.ref ? { ref: input.ref } : {}),
          }, inspection),
          this.controller.listUnclaimedWorkspaceDirt({
            cwd: input.cwd,
            modifiedSince: requireInspectionModifiedSince(modifiedSince),
          }, inspection),
        ]);
        return Response.json({ ...result, unclaimedDirtPaths });
      }
      case "proposalCreate": return Response.json(await this.controller.createProposal({
        ...common, amend: input.amend, description: input.description,
        ...(input.amendProposalId ? { amendProposalId: input.amendProposalId } : {}),
        ...(input.freshDescription !== undefined ? { freshDescription: input.freshDescription } : {}),
        ...(input.freshTitle ? { freshTitle: input.freshTitle } : {}),
        ...(input.paths ? { paths: input.paths } : {}),
        ...(input.replaceProposalId ? { replaceProposalId: input.replaceProposalId } : {}), title: input.title,
      }));
      case "proposalRescind": return Response.json(await this.controller.rescindProposal({ ...common, proposalId: input.proposalId }));
      case "proposalState": return Response.json(await this.controller.getProposal({
        ...common, includeNewer: input.includeNewer, proposalId: input.proposalId,
      }));
      case "proposalCommit": return Response.json(await this.controller.commitProposal({
        ...common, description: input.description, includeNewer: input.includeNewer,
        proposalId: input.proposalId, title: input.title,
      }));
      case "readDiffArtifact": return new Response(await this.controller.readLegacyDiffArtifact({
        artifactId: input.diffArtifactId, threadId: input.threadId,
      }), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      case "restore": return Response.json(await this.controller.restore({
        ...common, checkpointCommit: input.checkpointCommit,
        ...(input.confirmRestore !== undefined ? { confirmRestore: input.confirmRestore } : {}),
        ...(input.paths ? { paths: input.paths } : {}),
      }));
    }
  }
}

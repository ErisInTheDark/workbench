/*
 * Exports:
 * - WorkbenchGitArcFeatureOptions: project resolution and stable transition ports for reloadable Git arc work. Keywords: git, arc, feature, orchestrator.
 * - default WorkbenchGitArcFeature: own typed Git arc HTTP/direct dispatch inside the reloadable feature graph. Keywords: git, arc, controller, reload, HTTP.
 */
import type http from "node:http";

import WorkbenchGitCheckpointController, { type GitArcActiveClaim, type GitArcLifecycleState, type GitArcPlanState } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import { GitArcAcceptedProposalsError } from "../lib/workbench/git/GitArcProposalController";
import {
  createGitArcOperationRejected,
  formatGitArcFailureText,
  GitArcFailureException,
  GitArcMissingClaimSetError,
  GitArcProposalAlreadyCommittedError,
  type GitArcFailure,
} from "../lib/workbench/git/git-arc-failures";
import { GitCheckpointDirtyPathsError } from "../lib/workbench/git/GitArcPlanController";
import { GitArcStartDiagnosticError } from "../lib/workbench/git/git-arc-start-diagnostics";
import { GitArcCollisionError } from "../lib/workbench/git/GitArcRegistry";
import { GitCheckpointMissingObjectError } from "../lib/workbench/git/GitCheckpointStore";
import type { WorkbenchHarness } from "../lib/types";
import { GitCheckpointRequestSchema, type GitCheckpointRequest } from "../lib/workbench/git/checkpoint-contracts";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchThreadClaimContext } from "./WorkbenchThreadStateController";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface WorkbenchGitArcFeatureOptions {
  getThreadClaimContext(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<WorkbenchThreadClaimContext | null>;
  refreshThreadGitArcState(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<void>;
  resolveProjectFromCwd(cwd: string): Promise<{ cwd: string; project: { id: string } }>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">;
}

const GIT_ARC_STATE_MUTATION_ACTIONS = new Set<GitCheckpointRequest["action"]>([
  "arcAdd", "arcAdopt", "arcContinue", "arcMove", "arcRemove", "arcStart", "plan", "planAdd", "planAdopt", "planRemove", "planStart",
  "proposalCommit", "proposalCreate", "proposalRescind", "restore",
]);
const CLAIM_START_ACTIONS = new Set<GitCheckpointRequest["action"]>(["arcContinue", "arcStart", "planStart"]);

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
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
  private readonly controller = new WorkbenchGitCheckpointController();

  constructor(private readonly options: WorkbenchGitArcFeatureOptions) {}

  async findActiveClaim(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcActiveClaim | null> {
    return await this.controller.findActiveClaim({ cwd, harness, threadId });
  }

  async listActiveClaims(cwd: string): Promise<GitArcActiveClaim[]> {
    return await this.controller.listActiveClaims({ cwd });
  }

  async findLifecycleState(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcLifecycleState | null> {
    return await this.controller.findLifecycleState({ cwd, harness, threadId });
  }

  async listLifecycleStates(cwd: string): Promise<GitArcLifecycleState[]> {
    return await this.controller.listLifecycleStates({ cwd });
  }

  async findPlanState(cwd: string, harness: WorkbenchHarness, threadId: string): Promise<GitArcPlanState | null> {
    return await this.controller.findPlanState({ cwd, harness, threadId });
  }

  async listPlanStates(cwd: string): Promise<GitArcPlanState[]> {
    return await this.controller.listPlanStates({ cwd });
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

  async executeRequest(input: object) {
    const parsed = GitCheckpointRequestSchema.safeParse(input);
    if (!parsed.success) return failureResponse(createGitArcOperationRejected("unknown", "Invalid checkpoint request."));
    try {
      const project = await this.options.resolveProjectFromCwd(parsed.data.cwd);
      const request = { ...parsed.data, cwd: project.cwd };
      return await this.options.transitions.run(project.cwd, async () => {
        try {
          if (CLAIM_START_ACTIONS.has(request.action)) {
            const before = await this.options.getThreadClaimContext(project.project.id, request.harness, request.threadId);
            if (!before) throw new Error("The managed thread is not available for Git arc ownership.");
            if (before.lifecycle.settled) throw new Error("A settled thread cannot start or continue a Git arc.");
          }
          let response: Response;
          try {
            response = await this.dispatch(request);
          } catch (error) {
            throw new GitArcFailureException(await this.createFailure(project.project.id, request, error));
          }
          if (response.ok && CLAIM_START_ACTIONS.has(request.action)) {
            const after = await this.options.getThreadClaimContext(project.project.id, request.harness, request.threadId);
            if (after?.lifecycle.settled) {
              await this.controller.releaseActiveClaim({ cwd: project.cwd, harness: request.harness, threadId: request.threadId });
              throw new Error("The thread settled while its Git arc claim was starting. The new claim was released.");
            }
          }
          return response;
        } finally {
          if (mutatesGitArcState(request)) {
            await this.refreshThreadGitArcState(project.project.id, request.harness, request.threadId);
          }
        }
      });
    } catch (error) {
      const failure = error instanceof GitArcFailureException
        ? error.failure
        : createGitArcOperationRejected(
          parsed.data.action,
          error instanceof Error ? error.message : "Unable to run Git arc operation.",
        );
      return failureResponse(failure);
    }
  }

  private async createFailure(projectId: string, request: GitCheckpointRequest, error: unknown): Promise<GitArcFailure> {
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
    const collisions = error instanceof GitArcCollisionError
      ? error.collisions
      : error instanceof GitArcStartDiagnosticError ? error.details.collisions : [];
    const conflicts = await Promise.all(collisions.slice(0, 8).map(async (collision) => {
      const ownerContext = await this.options.getThreadClaimContext(
        projectId,
        collision.entry.harness as WorkbenchHarness,
        collision.entry.threadId,
      );
      const owner = liveCollisionOwner(collision.entry);
      return {
        overlaps: collision.overlaps.slice(0, 20),
        owner: {
          checkpointCommit: owner.checkpointCommit,
          harness: collision.entry.harness,
          intentName: owner.intentName,
          lifecycle: ownerContext?.lifecycle.kind ?? "unknown",
          threadId: collision.entry.threadId,
          title: ownerContext?.title.trim() || owner.intentName,
        },
      };
    }));
    if (error instanceof GitArcCollisionError) {
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
    return createGitArcOperationRejected(
      request.action,
      error instanceof Error ? error.message : "Unable to run Git arc operation.",
    );
  }

  private async refreshThreadGitArcState(projectId: string, harness: WorkbenchHarness, threadId: string) {
    try {
      await this.options.refreshThreadGitArcState(projectId, harness, threadId);
    } catch (error) {
      console.error(`Git arc state refresh failed after a mutation attempt: ${sanitizeError(error)}`);
    }
  }

  private async dispatch(input: GitCheckpointRequest) {
    const common = { cwd: input.cwd, harness: input.harness, threadId: input.threadId };
    switch (input.action) {
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
      case "arcContinue": return Response.json(await this.controller.continueArc({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcAdd": return Response.json(await this.controller.addToArc({ ...common, paths: input.paths }));
      case "arcAdopt": return Response.json(await this.controller.adoptIntoArc({ ...common, paths: input.paths }));
      case "arcMove": return Response.json(await this.controller.moveInArc({ ...common, move: input.move }));
      case "arcRemove": return Response.json(await this.controller.removeFromArc({ ...common, paths: input.paths }));
      case "compare": return Response.json(await this.controller.compare({
        ...common, ...(input.checkpointCommit ? { checkpointCommit: input.checkpointCommit } : {}), ...(input.paths ? { paths: input.paths } : {}),
      }));
      case "diff": return Response.json(await this.controller.diff({
        ...common, ...(input.checkpointCommit ? { checkpointCommit: input.checkpointCommit } : {}), ...(input.paths ? { paths: input.paths } : {}),
      }));
      case "proposalCreate": return Response.json(await this.controller.createProposal({
        ...common, amend: input.amend, description: input.description,
        ...(input.amendProposalId ? { amendProposalId: input.amendProposalId } : {}),
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

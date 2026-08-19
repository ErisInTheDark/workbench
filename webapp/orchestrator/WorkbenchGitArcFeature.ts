/*
 * Exports:
 * - WorkbenchGitArcFeatureOptions: project resolution and stable transition ports for reloadable Git arc work. Keywords: git, arc, feature, orchestrator.
 * - default WorkbenchGitArcFeature: own typed Git arc HTTP/direct dispatch inside the reloadable feature graph. Keywords: git, arc, controller, reload, HTTP.
 */
import type http from "node:http";

import WorkbenchGitCheckpointController, { type GitArcActiveClaim } from "../lib/workbench/git/WorkbenchGitCheckpointController";
import { GitArcCollisionError } from "../lib/workbench/git/GitArcRegistry";
import type { WorkbenchHarness } from "../lib/types";
import { GitCheckpointRequestSchema, type GitCheckpointRequest } from "../lib/workbench/git/checkpoint-contracts";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchThreadClaimContext } from "./WorkbenchThreadStateController";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export interface WorkbenchGitArcFeatureOptions {
  getThreadClaimContext(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<WorkbenchThreadClaimContext | null>;
  refreshThreadClaim(projectId: string, harness: WorkbenchHarness, threadId: string): Promise<void>;
  resolveProjectFromCwd(cwd: string): Promise<{ cwd: string; project: { id: string } }>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">;
}

const CLAIM_MUTATION_ACTIONS = new Set<GitCheckpointRequest["action"]>([
  "arcAdd", "arcAdopt", "arcContinue", "arcRemove", "arcStart", "proposalCommit", "proposalCreate", "restore",
]);
const CLAIM_START_ACTIONS = new Set<GitCheckpointRequest["action"]>(["arcContinue", "arcStart"]);

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
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

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      await sendResponse(response, await this.executeRequest(JSON.parse(await readBody(request)) as object));
    } catch (error) {
      await sendResponse(response, Response.json({
        error: error instanceof Error ? error.message : "Invalid Git arc request.",
      }, { status: 400 }));
    }
  }

  async executeRequest(input: object) {
    const parsed = GitCheckpointRequestSchema.safeParse(input);
    if (!parsed.success) return Response.json({ error: "Invalid checkpoint request." }, { status: 400 });
    try {
      const project = await this.options.resolveProjectFromCwd(parsed.data.cwd);
      const request = { ...parsed.data, cwd: project.cwd };
      const key = `git-arc\0${project.cwd.toLowerCase()}`;
      return await this.options.transitions.run(key, async () => {
        if (CLAIM_START_ACTIONS.has(request.action)) {
          const before = await this.options.getThreadClaimContext(project.project.id, request.harness, request.threadId);
          if (!before) throw new Error("The managed thread is not available for Git arc ownership.");
          if (before.lifecycle.settled) throw new Error("A settled thread cannot start or continue a Git arc.");
        }
        let response: Response;
        try {
          response = await this.dispatch(request);
        } catch (error) {
          if (!(error instanceof GitArcCollisionError)) throw error;
          const details = await Promise.all(error.collisions.map(async ({ entry, overlaps }) => {
            const owner = await this.options.getThreadClaimContext(project.project.id, entry.harness as WorkbenchHarness, entry.threadId);
            const description = entry.intentDescription.trim() ? `, ${entry.intentDescription.trim()}` : "";
            const lifecycle = owner ? owner.lifecycle.kind : "unknown lifecycle";
            const title = owner?.title.trim() || entry.threadId;
            const overlapText = overlaps.map(({ claimedPath, requestedPath }) => `${claimedPath} <> ${requestedPath}`).join(", ");
            return `${entry.harness}/${entry.threadId} \"${title}\" [${lifecycle}] ${entry.checkpointCommit.slice(0, 8)} ${entry.intentName}${description}; overlaps: ${overlapText}`;
          }));
          throw new Error(`Arc claims overlap active sibling work: ${details.join("; ")}`);
        }
        if (response.ok && CLAIM_MUTATION_ACTIONS.has(request.action)) {
          if (CLAIM_START_ACTIONS.has(request.action)) {
            const after = await this.options.getThreadClaimContext(project.project.id, request.harness, request.threadId);
            if (after?.lifecycle.settled) {
              await this.controller.releaseActiveClaim({ cwd: project.cwd, harness: request.harness, threadId: request.threadId });
              await this.refreshThreadClaim(project.project.id, request.harness, request.threadId);
              throw new Error("The thread settled while its Git arc claim was starting. The new claim was released.");
            }
          }
          await this.refreshThreadClaim(project.project.id, request.harness, request.threadId);
        }
        return response;
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unable to run Git arc operation." }, { status: 400 });
    }
  }

  private async refreshThreadClaim(projectId: string, harness: WorkbenchHarness, threadId: string) {
    try {
      await this.options.refreshThreadClaim(projectId, harness, threadId);
    } catch (error) {
      console.error(`Git arc operation succeeded, but thread claim refresh failed: ${sanitizeError(error)}`);
    }
  }

  private async dispatch(input: GitCheckpointRequest) {
    const common = { cwd: input.cwd, harness: input.harness, threadId: input.threadId };
    switch (input.action) {
      case "plan": return Response.json(await this.controller.createPlan({ ...common, intentDescription: input.intentDescription, intentName: input.intentName, paths: input.paths }));
      case "arcStart": return Response.json(await this.controller.startArc({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcContinue": return Response.json(await this.controller.continueArc({ ...common, checkpointCommit: input.checkpointCommit }));
      case "arcAdd": return Response.json(await this.controller.addToArc({ ...common, paths: input.paths }));
      case "arcAdopt": return Response.json(await this.controller.adoptIntoArc({ ...common, paths: input.paths }));
      case "arcRemove": return Response.json(await this.controller.removeFromArc({ ...common, paths: input.paths }));
      case "compare": return Response.json(await this.controller.compare({
        ...common, ...(input.paths ? { paths: input.paths } : {}),
      }));
      case "diff": return Response.json(await this.controller.diff({
        ...common, ...(input.paths ? { paths: input.paths } : {}),
      }));
      case "proposalCreate": return Response.json(await this.controller.createProposal({
        ...common, amend: input.amend, description: input.description,
        ...(input.paths ? { paths: input.paths } : {}), title: input.title,
      }));
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

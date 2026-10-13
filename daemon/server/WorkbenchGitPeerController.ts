/*
 * Exports:
 * - default WorkbenchGitPeerController: own this daemon's side of app-relayed peer transfers: held commits, branch bundles,
 *   received bundles and integration of a peer's branch into the checked-out branch.
 */
import type http from "node:http";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  GIT_PEER_NO_BUNDLE_HEADER, GIT_PEER_ROUTES, GIT_PEER_TIP_HEADER, GitPeerBundleRequestSchema, GitPeerHavesRequestSchema, GitPeerIntegrateRequestSchema,
  GitPeerReceiveQuerySchema, type GitPeerAddress, type GitPeerIntegrationResult,
} from "workbench-shared/workbench/git/git-peer-contracts";
import WorkbenchGitIntegration from "./lib/workbench/git/WorkbenchGitIntegration";
import WorkbenchGitPeerTransport, { GitPeerMissingBranchError } from "./lib/workbench/git/WorkbenchGitPeerTransport";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import type { createWorktreeGitTransitions } from "./worktree-git-transitions";

const MAX_JSON_BYTES = 64 * 1024;

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_JSON_BYTES) throw new RequestError(413, "Peer request is too large.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new RequestError(400, "Peer request is not JSON."); }
}

function parse<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError(400, "Peer request is invalid.");
  return parsed.data;
}

function sendJson(response: http.ServerResponse, status: number, payload: object) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function bounded(error: unknown) {
  return (error instanceof Error ? error.message : "Peer request failed.").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
}

export default class WorkbenchGitPeerController {
  constructor(private readonly options: {
    resolveRoot(projectId: string): Promise<string | null>;
    transitions: Pick<ReturnType<typeof createWorktreeGitTransitions>, "run">;
    warn(message: string): void;
  }) {}

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const cancellation = new AbortController();
    const disconnected = () => { if (!response.writableFinished) cancellation.abort(); };
    response.once("close", disconnected);
    try {
      switch (url.pathname) {
        case GIT_PEER_ROUTES.haves: {
          const body = parse(GitPeerHavesRequestSchema, await readJson(request));
          const transport = await this.transport(body.projectId);
          sendJson(response, 200, { haves: (await transport.haves(body.peer, body.branch)).slice(0, 8) });
          return;
        }
        case GIT_PEER_ROUTES.bundle: {
          const body = parse(GitPeerBundleRequestSchema, await readJson(request));
          const transport = await this.transport(body.projectId);
          const { tip, bundle, done } = await transport.bundle(body.branch, body.haves, cancellation.signal);
          if (!bundle) {
            response.writeHead(204, { "Cache-Control": "no-store", [GIT_PEER_TIP_HEADER]: tip }).end();
            return;
          }
          response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/x-git-bundle", [GIT_PEER_TIP_HEADER]: tip });
          try {
            await Promise.all([pipeline(bundle, response), done]);
          } catch (error) {
            if (!cancellation.signal.aborted) this.options.warn(`Peer bundle failed: ${bounded(error)}`);
            response.destroy();
          }
          return;
        }
        case GIT_PEER_ROUTES.receive: {
          const query = parse(GitPeerReceiveQuerySchema, Object.fromEntries(url.searchParams));
          const transport = await this.transport(query.projectId);
          const peer: GitPeerAddress = { daemonId: query.peerDaemonId, projectId: query.peerProjectId };
          const tip = await transport.receive(peer, query.branch, query.tip,
            request.headers[GIT_PEER_NO_BUNDLE_HEADER] === "1" ? null : request, cancellation.signal);
          sendJson(response, 200, { tip });
          return;
        }
        case GIT_PEER_ROUTES.integrate: {
          const body = parse(GitPeerIntegrateRequestSchema, await readJson(request));
          sendJson(response, 200, await this.integrate(body.projectId, body.peer, body.branch));
          return;
        }
        default:
          sendJson(response, 404, { error: "Not found" });
      }
    } catch (error) {
      if (cancellation.signal.aborted) return;
      const status = error instanceof RequestError ? error.status : error instanceof GitPeerMissingBranchError ? 409 : 500;
      if (status === 500) this.options.warn(`Peer request failed: ${bounded(error)}`);
      if (response.headersSent) response.destroy();
      else sendJson(response, status, { error: bounded(error) });
    } finally {
      response.off("close", disconnected);
    }
  }

  private async repository(projectId: string) {
    const root = await this.options.resolveRoot(projectId);
    const repository = root ? await WorkbenchGitRepository.tryOpen(root) : null;
    if (!repository) throw new RequestError(409, "This folder is not a Git checkout.");
    return repository;
  }

  private async transport(projectId: string) {
    return new WorkbenchGitPeerTransport(await this.repository(projectId));
  }

  /** Fast-forward or replay local commits onto the peer's branch, never touching commits any peer or remote holds. */
  private async integrate(projectId: string, peer: GitPeerAddress, branch: string): Promise<GitPeerIntegrationResult> {
    const repository = await this.repository(projectId);
    return await this.options.transitions.run(repository.root, async () => {
      const head = (await repository.run(["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
      if (head !== `refs/heads/${branch}`) {
        return { kind: "blocked", reason: `This folder no longer has ${branch} checked out.`, conflicts: [] };
      }
      const incoming = await new WorkbenchGitPeerTransport(repository).trackingTip(peer, branch);
      if (!incoming) throw new RequestError(409, "The peer's branch has not been fetched here yet.");
      const integration = new WorkbenchGitIntegration(repository);
      const plan = await integration.prepare(incoming);
      if (plan.kind === "current") return { kind: "current" };
      if (plan.kind === "blocked") return { kind: "blocked", reason: plan.reason, conflicts: plan.conflicts.slice(0, 50) };
      const applied = await integration.apply(plan);
      return { kind: "applied", mode: plan.kind, fromSha: applied.fromSha, toSha: applied.toSha,
        warnings: applied.warnings.map(warning => bounded(new Error(String(warning)))) };
    });
  }
}

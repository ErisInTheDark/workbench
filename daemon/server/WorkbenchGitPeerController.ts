/*
 * Exports:
 * - default WorkbenchGitPeerController: own this daemon's side of app-relayed peer transfers: held commits, branch bundles,
 *   received bundles, inspected ancestry and expected-tip integration of a peer's branch.
 */
import type http from "node:http";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  GIT_PEER_NO_BUNDLE_HEADER, GIT_PEER_ROUTES, GIT_PEER_TIP_HEADER, GitBranchNameSchema, GitPeerBundleRequestSchema, GitPeerHavesRequestSchema, GitPeerIntegrateRequestSchema,
  GitPeerReceiveQuerySchema, type GitPeerAddress, type GitPeerIntegrationResult, type GitPeerApplyOptions,
  type GitPeerIntegrationSnapshot,
} from "workbench-shared/workbench/git/git-peer-contracts";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import WorkbenchGitIntegration from "./lib/workbench/git/WorkbenchGitIntegration";
import WorkbenchGitPeerTransport, { GitPeerMissingBranchError } from "./lib/workbench/git/WorkbenchGitPeerTransport";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import type { createWorktreeGitTransitions } from "./worktree-git-transitions";

const MAX_JSON_BYTES = 64 * 1024;
const INVALID_DAEMON_ID = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000000");
const INVALID_PROJECT_ID = ProjectIdSchema.parse("__invalid_peer_request__");
const INVALID_BRANCH = GitBranchNameSchema.parse("__invalid_peer_request__");
const INVALID_TIP = "0".repeat(40);
const INVALID_PEER = { daemonId: INVALID_DAEMON_ID, projectId: INVALID_PROJECT_ID };
const INVALID_HAVES_REQUEST = { projectId: INVALID_PROJECT_ID, peer: INVALID_PEER, branch: INVALID_BRANCH };
const INVALID_BUNDLE_REQUEST = { projectId: INVALID_PROJECT_ID, branch: INVALID_BRANCH, haves: [] };
const INVALID_RECEIVE_QUERY = {
  projectId: INVALID_PROJECT_ID,
  peerDaemonId: INVALID_DAEMON_ID,
  peerProjectId: INVALID_PROJECT_ID,
  branch: INVALID_BRANCH,
  tip: INVALID_TIP,
};

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

function parse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  defaults: z.input<Schema>,
  context: string,
  warn: (message: string) => void,
): z.output<Schema> {
  const conformed = conformToZodSchema(schema, value, defaults);
  if (conformed.fallbackPaths.length) throw new RequestError(400, "Peer request is invalid.");
  if (conformed.repairedPaths.length) {
    const paths = conformed.repairedPaths
      .slice(0, 10)
      .map(path => path.map(part => String(part).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")).join(".") || "<root>")
      .join(", ")
      .slice(0, 500);
    warn(`Conformed ${context} peer request: repairedPaths=${paths}`);
  }
  return conformed.data;
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
          const body = parse(GitPeerHavesRequestSchema, await readJson(request),
            INVALID_HAVES_REQUEST, "haves", this.options.warn);
          const transport = await this.transport(body.projectId);
          sendJson(response, 200, { haves: (await transport.haves(body.peer, body.branch)).slice(0, 8) });
          return;
        }
        case GIT_PEER_ROUTES.bundle: {
          const body = parse(GitPeerBundleRequestSchema, await readJson(request),
            INVALID_BUNDLE_REQUEST, "bundle", this.options.warn);
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
          const query = parse(GitPeerReceiveQuerySchema, Object.fromEntries(url.searchParams),
            INVALID_RECEIVE_QUERY, "receive", this.options.warn);
          const transport = await this.transport(query.projectId);
          const peer: GitPeerAddress = { daemonId: query.peerDaemonId, projectId: query.peerProjectId };
          const tip = await transport.receive(peer, query.branch, query.tip,
            request.headers[GIT_PEER_NO_BUNDLE_HEADER] === "1" ? null : request, cancellation.signal);
          sendJson(response, 200, { tip });
          return;
        }
        case GIT_PEER_ROUTES.integrate: {
          const body = parse(GitPeerIntegrateRequestSchema, await readJson(request),
            { ...INVALID_HAVES_REQUEST, expectedHead: INVALID_TIP, incoming: INVALID_TIP, mode: "fastForward" },
            "integrate", this.options.warn);
          sendJson(response, 200, await this.integrate(body.projectId, body.peer, body.branch, body));
          return;
        }
        case GIT_PEER_ROUTES.inspect: {
          const body = parse(GitPeerHavesRequestSchema, await readJson(request),
            INVALID_HAVES_REQUEST, "inspect integration", this.options.warn);
          const repository = await this.repository(body.projectId);
          sendJson(response, 200, await this.options.transitions.run(repository.root,
            () => this.inspect(repository, body.peer, body.branch)));
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

  private async inspect(repository: WorkbenchGitRepository, peer: GitPeerAddress, branch: string): Promise<GitPeerIntegrationSnapshot> {
    if (await repository.symbolicHead() !== `refs/heads/${branch}`) {
      throw new RequestError(409, `This folder no longer has ${branch} checked out.`);
    }
    const incoming = await new WorkbenchGitPeerTransport(repository).trackingTip(peer, branch);
    if (!incoming) throw new RequestError(409, "The peer's branch has not been fetched here yet.");
    const head = await repository.currentHead();
    const [ahead, behind] = (await repository.run(["rev-list", "--left-right", "--count", `${head}...${incoming}`]))
      .trim().split(/\s+/u).map(Number);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Error("Invalid peer ancestry counts.");
    return { head, incoming, ahead: ahead!, behind: behind! };
  }

  private async integrate(projectId: string, peer: GitPeerAddress, branch: string,
    input: GitPeerApplyOptions): Promise<GitPeerIntegrationResult> {
    const repository = await this.repository(projectId);
    // Network I/O stays outside the worktree lease; expected tips are checked after it.
    if (input.mode === "replay" && (await repository.remotes()).length) await repository.fetchRemotes();
    return await this.options.transitions.run(repository.root, async () => {
      const snapshot = await this.inspect(repository, peer, branch);
      if (snapshot.head !== input.expectedHead || snapshot.incoming !== input.incoming) {
        return { kind: "blocked", reason: "A branch changed after inspection; refresh and try again.", conflicts: [] };
      }
      const integration = new WorkbenchGitIntegration(repository);
      const plan = await integration.prepare(input.incoming, input.mode);
      if (plan.kind === "current") return { kind: "current" };
      if (plan.kind === "blocked") return { kind: "blocked", reason: plan.reason, conflicts: plan.conflicts.slice(0, 50) };
      const applied = await integration.apply(plan);
      return { kind: "applied", mode: plan.kind, fromSha: applied.fromSha, toSha: applied.toSha,
        warnings: applied.warnings.map(warning => bounded(new Error(String(warning)))) };
    });
  }
}

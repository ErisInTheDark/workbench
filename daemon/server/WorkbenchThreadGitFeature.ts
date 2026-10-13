/*
 * Exports:
 * - WorkbenchThreadGitFeatureOptions: project resolution, thread Git construction, stable transition and integration claim ports.
 * - WorkbenchThreadGitRequestPorts: per-request cancellation and peer fetch supplied by the agent command host.
 * - CommitThreadLookup/findCommitThreadId: classify committed proposal ownership across thread arc summaries.
 * - default WorkbenchThreadGitFeature: own validated thread-scoped mutations, committed-proposal owner lookup and
 *   `wb git integrate` sessions.
 */
import type http from "node:http";
import { ThreadReferenceSchema, type WorkbenchThreadId, type ProjectId } from "workbench-shared/workbench/identity";
import type WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import type { WorkbenchGitArcLifecycleState, WorkbenchThreadGitCommit } from "workbench-shared/workbench/thread/thread-state";

import WorkbenchThreadGit from "./lib/workbench/git/WorkbenchThreadGit";
import type {
  WorkbenchThreadGitAmendRequest,
  WorkbenchThreadGitCommitResult,
  WorkbenchThreadGitSelectionResult,
} from "./lib/workbench/git/WorkbenchThreadGit";
import WorkbenchGitRepository from "./lib/workbench/git/WorkbenchGitRepository";
import WorkbenchGitIntegrationSession, { type WorkbenchGitIntegrationClaim } from "./lib/workbench/git/WorkbenchGitIntegrationSession";
import type { GitPeerFetchOutcome, GitPeerFetchQuestion } from "workbench-shared/workbench/git/git-peer-contracts";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

type ThreadGitAction = "add" | "amend" | "commit" | "integrate" | "thread" | "unstage";
const INTEGRATE_OPERATIONS = ["start", "view", "resolve", "wait", "apply", "end"] as const;
type IntegrateOperation = typeof INTEGRATE_OPERATIONS[number];

/** Per-request ports the agent command host supplies: caller cancellation and the connected app's peer fetch. */
export interface WorkbenchThreadGitRequestPorts {
  signal?: AbortSignal;
  fetchPeer?(question: GitPeerFetchQuestion, signal: AbortSignal): Promise<Extract<GitPeerFetchOutcome, { kind: "fetched" }>>;
}

export type CommitThreadLookup =
  | { kind: "ambiguous"; threadIds: string[] }
  | { kind: "found"; threadId: string }
  | { kind: "missing" };

interface CommitThreadRecord {
  gitArc?: WorkbenchGitArcLifecycleState | null;
  gitCommits?: readonly WorkbenchThreadGitCommit[];
  threadId: string;
}

interface ThreadGitPort {
  add(paths: string[]): Promise<WorkbenchThreadGitSelectionResult>;
  amend(request: WorkbenchThreadGitAmendRequest): Promise<WorkbenchThreadGitCommitResult>;
  commit(message: string, amendTarget?: string): Promise<WorkbenchThreadGitCommitResult>;
  repoRoot: string;
  unstage(paths: string[]): Promise<WorkbenchThreadGitSelectionResult>;
}

export interface WorkbenchThreadGitFeatureOptions {
  identities: WorkbenchThreadIdentityController;
  createThreadGit?: (options: { cwd: string; targetWorktree?: string; threadId: WorkbenchThreadId }) => Promise<ThreadGitPort>;
  selectionStore?: Pick<WorkbenchDatabaseController, "executeThreadGitSelection" | "readThreadStateProject">;
  resolveProjectFromCwd(cwd: string): Promise<{ cwd: string; project?: { id: ProjectId } }>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "read" | "run">;
  /** `wb git integrate`: live claims per thread, and re-running a blocked check whenever claims change. */
  integrations?: {
    listClaims(repository: WorkbenchGitRepository): Promise<WorkbenchGitIntegrationClaim[]>;
    waitForClaims<Result extends { kind: string }>(
      attempt: () => Promise<Result | { kind: "blocked" }>, signal: AbortSignal,
    ): Promise<Exclude<Result, { kind: "blocked" }>>;
  };
}

function readAction(value: unknown): ThreadGitAction | null {
  return value === "add" || value === "amend" || value === "commit" || value === "integrate" || value === "thread" || value === "unstage"
    ? value
    : null;
}

function readIntegrateOperation(value: unknown): IntegrateOperation {
  const operation = INTEGRATE_OPERATIONS.find(candidate => candidate === value);
  if (!operation) throw new Error("A valid integrate operation is required.");
  return operation;
}

function textResponse(text: string) {
  return new Response(text, { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAmendRequest(body: Record<string, unknown>): WorkbenchThreadGitAmendRequest {
  const coAuthors = readPaths(body.coAuthors);
  if (body.clearCoAuthors === true && coAuthors.length) throw new Error("Co-authors cannot be both replaced and cleared.");
  return {
    author: readOptionalString(body.author),
    authorDate: readOptionalString(body.authorDate),
    coAuthors: body.clearCoAuthors === true ? null : coAuthors.length ? coAuthors : undefined,
    commits: readPaths(body.commits),
    committer: readOptionalString(body.committer),
    committerDate: readOptionalString(body.committerDate),
    includeSelection: body.includeSelection === true,
    message: readOptionalString(body.message),
    ranges: readPaths(body.ranges),
  };
}

function rewriteResponse(result: WorkbenchThreadGitCommitResult, amended: ReadonlyArray<{ commit: string; original: string }>) {
  return new Response([
    ...(result.amendedCommit ? [
      ...amended.map(({ commit, original }) => `Amended ${original} as ${commit}`),
      `Rewritten HEAD ${result.commit} (${result.rewrittenCommitCount} commits)`,
    ] : [`Committed ${result.commit}`]),
    ...(result.committedPaths.length || !result.amendedCommit ? [
      `Committed files (${result.committedPaths.length}):`,
      ...result.committedPaths.map((filePath) => `  ${filePath}`),
    ] : []),
    ...(result.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
    "",
  ].join("\n"), {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function readPaths(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function findCommitThreadId(records: readonly CommitThreadRecord[], commitSha: string): CommitThreadLookup {
  const owners = new Set<string>();
  for (const record of records) {
    if (record.gitCommits?.some(commit => commit.commitSha === commitSha)) owners.add(record.threadId);
    if (record.gitArc) {
      for (const arc of [record.gitArc, ...record.gitArc.members ?? []]) {
        if (arc.proposals.some(proposal => proposal.summary?.committedSha === commitSha)) owners.add(record.threadId);
      }
    }
  }
  const threadIds = [...owners].sort((left, right) => left.localeCompare(right));
  if (!threadIds.length) return { kind: "missing" };
  return threadIds.length === 1 ? { kind: "found", threadId: threadIds[0]! } : { kind: "ambiguous", threadIds };
}

function selectionResponse(verb: string, changedPaths: string[], selectedPaths: string[]) {
  const lines = [
    `${verb} ${changedPaths.length} ${changedPaths.length === 1 ? "file" : "files"}.`,
    `Thread selection (${selectedPaths.length}):`,
    ...selectedPaths.map((filePath) => `  ${filePath}`),
  ];
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) throw new Error("Workbench thread Git request is too large.");
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

export default class WorkbenchThreadGitFeature {
  private readonly createThreadGit: NonNullable<WorkbenchThreadGitFeatureOptions["createThreadGit"]>;

  constructor(private readonly options: WorkbenchThreadGitFeatureOptions) {
    this.createThreadGit = options.createThreadGit ?? (async (input) => {
      if (!options.selectionStore) throw new Error("Thread Git database storage is unavailable.");
      return await WorkbenchThreadGit.create({ ...input, selectionStore: options.selectionStore });
    });
  }

  async handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      await sendResponse(response, await this.executeRequest(JSON.parse(await readBody(request)) as object));
    } catch (error) {
      await sendResponse(response, Response.json({
        error: error instanceof Error ? error.message : "Invalid thread Git request.",
      }, { status: 400 }));
    }
  }

  async executeRequest(input: object, ports: WorkbenchThreadGitRequestPorts = {}) {
    try {
      const body = input as Record<string, unknown>;
      const action = readAction(body.action);
      const cwd = readString(body.cwd);
      const targetWorktree = readString(body.targetWorktree) || undefined;
      if (!action) throw new Error("A valid thread Git action is required.");
      const resolved = await this.options.resolveProjectFromCwd(cwd);
      if (action === "integrate") return await this.integrate(body, resolved, ports);
      if (action === "thread") {
        const commitish = readString(body.commit);
        if (!commitish) throw new Error("A Git commit is required.");
        if (!resolved.project) throw new Error("The current directory has no Workbench project.");
        if (!this.options.selectionStore) throw new Error("Thread Git database storage is unavailable.");
        const projectId = resolved.project.id;
        const selectionStore = this.options.selectionStore;
        const repository = await WorkbenchGitRepository.open(resolved.cwd);
        return await this.options.transitions.read(repository.root, async () => {
          const resolvedCommit = await repository.readCommitAt(commitish);
          if (!resolvedCommit) throw new Error(`Git commit is unavailable: ${commitish}`);
          const document = await selectionStore.readThreadStateProject(projectId);
          const match = findCommitThreadId(document.records.map(record => ({
            gitArc: record.gitArc,
            gitCommits: record.gitCommits,
            threadId: record.identity.threadId,
          })), resolvedCommit.commit);
          if (match.kind === "missing") throw new Error(`No Workbench thread owns commit ${resolvedCommit.commit}.`);
          if (match.kind === "ambiguous") {
            throw new Error(`Commit ${resolvedCommit.commit} belongs to multiple Workbench threads: ${match.threadIds.join(", ")}`);
          }
          return new Response(`${match.threadId}\n`, {
            headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
          });
        });
      }
      const threadId = readString(body.threadId);
      if (!threadId) throw new Error("A managed Workbench thread id is required.");
      const identity = await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: resolved.project?.id });
      if (!identity) throw new Error("The managed thread has no Git storage identity.");
      const threadGit = await this.createThreadGit({
        cwd: resolved.cwd, targetWorktree, threadId: identity.threadId,
      });
      return await this.options.transitions.run(threadGit.repoRoot, async () => {
        if (action === "commit") {
          const amendTarget = readString(body.amendTarget) || undefined;
          const result = await threadGit.commit(readString(body.message), amendTarget);
          return rewriteResponse(result, result.amendedCommit && amendTarget ? [{ commit: result.amendedCommit, original: amendTarget }] : []);
        }
        if (action === "amend") {
          const result = await threadGit.amend(readAmendRequest(body));
          return rewriteResponse(result, result.amendedCommits ?? []);
        }

        const paths = readPaths(body.paths);
        const result = action === "add" ? await threadGit.add(paths) : await threadGit.unstage(paths);
        return selectionResponse(action === "add" ? "Selected" : "Unselected", result.changedPaths, result.selectedPaths);
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "Unable to run thread Git operation.",
      }, {
        headers: { "Cache-Control": "no-store" },
        status: 400,
      });
    }
  }

  /** `wb git integrate`: builds read-only under the worktree transition; only apply holds it exclusively. */
  private async integrate(body: Record<string, unknown>, resolved: { cwd: string; project?: { id: ProjectId } },
    ports: WorkbenchThreadGitRequestPorts) {
    const integrations = this.options.integrations;
    if (!integrations) throw new Error("Integration sessions are unavailable.");
    const operation = readIntegrateOperation(body.operation);
    const threadId = readString(body.threadId);
    if (!threadId) throw new Error("A managed Workbench thread id is required.");
    const identity = await this.options.identities.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: resolved.project?.id });
    if (!identity) throw new Error("The managed thread has no Git storage identity.");
    const repository = await WorkbenchGitRepository.open(resolved.cwd);
    const session = new WorkbenchGitIntegrationSession({
      repository, threadId: identity.threadId, listClaims: () => integrations.listClaims(repository),
    });
    const signal = ports.signal ?? new AbortController().signal;
    const read = <Value>(work: () => Promise<Value>) => this.options.transitions.read(repository.root, work);
    switch (operation) {
      case "start": {
        const from = readString(body.from);
        if (!from) throw new Error("--from upstream|<host>[:<folder>] is required.");
        const mode = body.merge === true ? "merge" as const : "replay" as const;
        const carryOwn = body.carryOwn === true;
        if (from === "upstream") {
          const upstream = (await repository.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => "")).trim();
          if (!upstream) throw new Error("The checked-out branch has no upstream.");
          // Fetching writes only remote-tracking refs, so it runs outside the worktree transition like the updater's.
          await repository.run(["fetch", "--quiet"], { ...process.env, GIT_TERMINAL_PROMPT: "0" }, signal);
          const incoming = (await repository.run(["rev-parse", "@{u}"])).trim();
          return textResponse(await read(() => session.start({ incoming, source: { kind: "upstream", ref: upstream }, mode, carryOwn })));
        }
        if (!ports.fetchPeer) throw new Error("Peer fetches are unavailable here.");
        if (!resolved.project) throw new Error("The current directory has no Workbench project.");
        const branchRef = (await repository.run(["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
        if (!branchRef.startsWith("refs/heads/")) throw new Error("Detached HEAD cannot integrate incoming commits.");
        const separator = from.indexOf(":");
        const fetched = await ports.fetchPeer({
          projectId: resolved.project.id, branch: branchRef.slice("refs/heads/".length),
          host: separator < 0 ? from : from.slice(0, separator), folder: separator < 0 ? null : from.slice(separator + 1) || null,
        }, signal);
        return textResponse(await read(() => session.start({
          incoming: fetched.tip, source: { kind: "peer", hostname: fetched.hostname, rootPath: fetched.rootPath }, mode, carryOwn,
        })));
      }
      case "view": return textResponse(await read(() => session.view()));
      case "resolve": return textResponse(await read(() => session.resolve()));
      case "wait": {
        const result = await integrations.waitForClaims(() => read(() => session.waitAttempt()), signal);
        return textResponse(result.text);
      }
      case "apply": return textResponse(await this.options.transitions.run(repository.root, () => session.apply()));
      case "end": return textResponse(await session.end());
    }
  }
}

/*
 * Exports:
 * - WorkbenchThreadGitFeatureOptions: project resolution, thread Git construction, and stable transition ports. Keywords: git, thread, orchestrator, feature.
 * - default WorkbenchThreadGitFeature: own validated thread-scoped add, unstage, commit, and amend requests inside the reloadable orchestrator graph. Keywords: git, thread, commit, index, reload.
 */
import type http from "node:http";

import WorkbenchThreadGit from "../lib/workbench/git/WorkbenchThreadGit";
import type { WorkbenchThreadGitCommitResult, WorkbenchThreadGitSelectionResult } from "../lib/workbench/git/WorkbenchThreadGit";
import type WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

type ThreadGitAction = "add" | "commit" | "unstage";

interface ThreadGitPort {
  add(paths: string[]): Promise<WorkbenchThreadGitSelectionResult>;
  commit(message: string, amendTarget?: string): Promise<WorkbenchThreadGitCommitResult>;
  repoRoot: string;
  unstage(paths: string[]): Promise<WorkbenchThreadGitSelectionResult>;
}

export interface WorkbenchThreadGitFeatureOptions {
  identities?: WorkbenchThreadIdentityController;
  createThreadGit?: (options: { cwd: string; targetWorktree?: string; threadId: string }) => Promise<ThreadGitPort>;
  resolveProjectFromCwd(cwd: string): Promise<{ cwd: string; project?: { id: string } }>;
  transitions: Pick<WorkbenchThreadTransitionCoordinator, "run">;
}

function readAction(value: unknown): ThreadGitAction | null {
  return value === "add" || value === "commit" || value === "unstage" ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readPaths(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
    this.createThreadGit = options.createThreadGit ?? (async (input) => await WorkbenchThreadGit.create(input));
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

  async executeRequest(input: object) {
    try {
      const body = input as Record<string, unknown>;
      const action = readAction(body.action);
      const cwd = readString(body.cwd);
      const targetWorktree = readString(body.targetWorktree) || undefined;
      const threadId = readString(body.threadId);
      if (!action) throw new Error("A valid thread Git action is required.");
      if (!threadId) throw new Error("A managed Workbench thread id is required.");
      const resolved = await this.options.resolveProjectFromCwd(cwd);
      const identity = await this.options.identities?.resolve({ threadId, projectId: resolved.project?.id });
      if (this.options.identities && !identity?.bindings[0]) throw new Error("The managed thread has no native Git storage identity.");
      const threadGit = await this.createThreadGit({
        cwd: resolved.cwd, targetWorktree, threadId: identity?.bindings[0]?.nativeThreadId ?? threadId,
      });
      return await this.options.transitions.run(threadGit.repoRoot, async () => {
        if (action === "commit") {
          const amendTarget = readString(body.amendTarget) || undefined;
          const result = await threadGit.commit(readString(body.message), amendTarget);
          return new Response([
            ...(result.amendedCommit ? [
              `Amended ${amendTarget} as ${result.amendedCommit}`,
              `Rewritten HEAD ${result.commit} (${result.rewrittenCommitCount} commits)`,
            ] : [`Committed ${result.commit}`]),
            `Committed files (${result.committedPaths.length}):`,
            ...result.committedPaths.map((filePath) => `  ${filePath}`),
            ...(result.warnings?.map((warning) => `Warning: ${warning}`) ?? []),
            "",
          ].join("\n"), {
            headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
          });
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
}

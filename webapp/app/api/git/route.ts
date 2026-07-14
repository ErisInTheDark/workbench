/*
 * Exports:
 * - runtime: force thread-owned Git operations onto the Node.js runtime. Keywords: api, git, node runtime.
 * - dynamic: disable static caching for thread-owned Git operations. Keywords: api, git, dynamic.
 * - POST: validate cwd ownership and dispatch bounded add, unstage, or commit operations. Keywords: api, git, thread, commit.
 */
import { NextRequest, NextResponse } from "next/server";

import WorkbenchThreadGit from "../../../lib/workbench/git/WorkbenchThreadGit";
import { resolveAgentEndpointProjectFromCwd } from "../../../lib/workbench/project/agent-endpoint-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ThreadGitAction = "add" | "commit" | "unstage";

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
  return new NextResponse(`${lines.join("\n")}\n`, {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = readAction(body.action);
    const cwd = readString(body.cwd);
    const threadId = readString(body.threadId);
    if (!action) return NextResponse.json({ error: "A valid thread Git action is required." }, { status: 400 });
    if (!threadId) return NextResponse.json({ error: "A managed Workbench thread id is required." }, { status: 400 });
    const resolved = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Thread Git" });
    const threadGit = await WorkbenchThreadGit.create({ cwd: resolved.cwd, threadId });

    if (action === "commit") {
      const result = await threadGit.commit(readString(body.message));
      return new NextResponse([
        `Committed ${result.commit}`,
        `Committed files (${result.committedPaths.length}):`,
        ...result.committedPaths.map((filePath) => `  ${filePath}`),
        "",
      ].join("\n"), {
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const paths = readPaths(body.paths);
    const result = action === "add" ? await threadGit.add(paths) : await threadGit.unstage(paths);
    return selectionResponse(action === "add" ? "Selected" : "Unselected", result.changedPaths, result.selectedPaths);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to run thread Git operation.",
    }, {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    });
  }
}

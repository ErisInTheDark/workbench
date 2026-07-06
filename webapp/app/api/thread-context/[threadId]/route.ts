/*
 * Exports:
 * - runtime/dynamic: force thread context reorientation onto the Node.js runtime without static caching. Keywords: thread context, markdown, node.
 * - GET: read a CWD-owned Codex thread context bundle and return chronological reorientation Markdown. Keywords: agent endpoint, thread, context, markdown.
 */

import { NextRequest, NextResponse } from "next/server";

import type { WorkbenchThreadContextReadResponse } from "../../../../lib/types";
import { sendServerWorkbenchBridgeRequest } from "../../../../lib/codex/server-bridge";
import { isProjectCodexThread, toThreadPayload } from "../../../../lib/codex/thread-adapter";
import { resolveAgentEndpointProjectFromCwd } from "../../../../lib/workbench/project/agent-endpoint-project";
import { renderWorkbenchThreadContextMarkdown } from "../../../../lib/workbench/thread/thread-context-markdown";
import { buildWorkbenchThreadContextPieces } from "../../../../lib/workbench/thread/thread-context-projection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function markdownResponse(markdown: string) {
  return new NextResponse(markdown, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

function errorResponse(error: unknown) {
  return NextResponse.json({
    error: error instanceof Error ? error.message : "Unable to read thread context.",
  }, {
    status: 400,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  try {
    const { threadId: rawThreadId } = await params;
    const threadId = readString(rawThreadId);
    if (!threadId) {
      throw new Error("Thread context requires a threadId.");
    }

    const context = await sendServerWorkbenchBridgeRequest<WorkbenchThreadContextReadResponse>(request, "codex", {
      method: "thread/context/read",
      params: {
        includeTurns: true,
        threadId,
      },
      workbenchThreadHydration: { mode: "legacyFull" },
    });
    const resolvedProject = await resolveAgentEndpointProjectFromCwd(context.thread.cwd, { endpointName: "Thread context" });
    const projectRootPaths = resolvedProject.project.roots.map((root) => root.root);
    if (!isProjectCodexThread(context.thread, projectRootPaths)) {
      throw new Error("That Codex thread does not belong to this project.");
    }

    const thread = toThreadPayload(context.thread, "codex");
    const pieces = buildWorkbenchThreadContextPieces({
      browseScreenshotEntries: context.browseScreenshotEntries,
      questionnaireEntries: context.questionnaireEntries,
      steerEntries: context.steerEntries,
      thread,
    });
    return markdownResponse(renderWorkbenchThreadContextMarkdown(pieces));
  } catch (error) {
    return errorResponse(error);
  }
}

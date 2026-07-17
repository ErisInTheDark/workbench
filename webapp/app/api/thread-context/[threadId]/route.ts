/*
 * Exports:
 * - runtime/dynamic: force Thread Recall reads onto the Node.js runtime without static caching. Keywords: thread recall, markdown, node.
 * - GET: read a CWD-owned Codex thread and return one filtered bounded chronological recall page. Keywords: agent endpoint, thread recall, history, markdown.
 * - POST: page search results or one expanded narrative record through typed private CLI transport. Keywords: agent endpoint, thread recall, search, expand.
 */

import { NextRequest, NextResponse } from "next/server";

import type {
  WorkbenchThreadContextBundle,
  WorkbenchThreadContextReadResponse,
  WorkbenchThreadRecallKind,
  WorkbenchThreadRecallRequest,
} from "../../../../lib/types";
import { sendServerWorkbenchOrchestratorRequest } from "../../../../lib/codex/server-orchestrator";
import { isProjectCodexThread, toThreadPayload } from "../../../../lib/codex/thread-adapter";
import { resolveAgentEndpointProjectFromCwd } from "../../../../lib/workbench/project/agent-endpoint-project";
import {
  renderWorkbenchThreadRecallExpansionMarkdown,
  renderWorkbenchThreadRecallSearchMarkdown,
} from "../../../../lib/workbench/thread/thread-context-recall-markdown";
import {
  buildWorkbenchThreadRecallRecords,
  expandWorkbenchThreadRecall,
  searchWorkbenchThreadRecall,
  selectWorkbenchThreadRecallRecords,
} from "../../../../lib/workbench/thread/thread-context-recall";
import { renderWorkbenchThreadRecallHistoryMarkdown } from "../../../../lib/workbench/thread/thread-context-recall-markdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THREAD_RECALL_KINDS: readonly WorkbenchThreadRecallKind[] = [
  "agent-message",
  "commentary",
  "final-answer",
  "plan",
  "questionnaire",
  "user-message",
  "user-steer",
];

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    error: error instanceof Error ? error.message : "Unable to read Thread Recall.",
  }, {
    status: 400,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function readOptionalInteger(record: Record<string, unknown>, key: string, maximum: number) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${key} must be an integer between 0 and ${maximum}.`);
  }
  return value as number;
}

function readRecallKinds(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.length) {
    throw new Error("kinds must contain at least one Thread Recall kind.");
  }
  const allowed = new Set<string>(THREAD_RECALL_KINDS);
  const kinds = Array.from(new Set(value.map(readString)));
  if (kinds.some((kind) => !allowed.has(kind))) {
    throw new Error(`kinds must use only: ${THREAD_RECALL_KINDS.join(", ")}.`);
  }
  return kinds as WorkbenchThreadRecallKind[];
}

function parseRecallRequest(value: unknown): WorkbenchThreadRecallRequest {
  const record = asRecord(value);
  if (!record) {
    throw new Error("A Thread Recall request object is required.");
  }
  const action = readString(record.action);
  if (action === "search") {
    const query = readString(record.query);
    if (!query || query.length > 500) {
      throw new Error("Thread Recall search query must contain 1 to 500 characters.");
    }
    const kinds = readRecallKinds(record.kinds);
    const limit = readOptionalInteger(record, "limit", 50);
    if (limit === 0) {
      throw new Error("Thread Recall search limit must be between 1 and 50.");
    }
    const before = readString(record.before);
    if (before.length > 1_000) {
      throw new Error("Thread Recall search before ref must contain at most 1,000 characters.");
    }
    return {
      action,
      query,
      ...(kinds ? { kinds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(before ? { before } : {}),
    };
  }
  if (action === "expand") {
    const ref = readString(record.ref);
    if (!ref || ref.length > 1_000) {
      throw new Error("Thread Recall expand ref must contain 1 to 1,000 characters.");
    }
    const cursor = readString(record.cursor);
    if (cursor.length > 2_000) {
      throw new Error("Thread Recall expansion cursor must contain at most 2,000 characters.");
    }
    return {
      action,
      ref,
      ...(cursor ? { cursor } : {}),
    };
  }
  throw new Error("Thread Recall action must be search or expand.");
}

async function readThreadContextBundle(
  request: NextRequest,
  rawThreadId: string,
): Promise<WorkbenchThreadContextBundle> {
  const threadId = readString(rawThreadId);
  if (!threadId) {
    throw new Error("Thread Recall requires a threadId.");
  }

  const context = await sendServerWorkbenchOrchestratorRequest<WorkbenchThreadContextReadResponse>(request, "codex", {
    method: "thread/context/read",
    params: {
      includeTurns: true,
      threadId,
    },
    workbenchThreadHydration: { mode: "legacyFull" },
  });
  const resolvedProject = await resolveAgentEndpointProjectFromCwd(context.thread.cwd, { endpointName: "Thread Recall" });
  const projectRootPaths = resolvedProject.project.roots.map((root) => root.root);
  if (!isProjectCodexThread(context.thread, projectRootPaths)) {
    throw new Error("That Codex thread does not belong to this project.");
  }

  return {
    browseResultEntries: context.browseResultEntries,
    questionnaireEntries: context.questionnaireEntries,
    steerEntries: context.steerEntries,
    thread: toThreadPayload(context.thread, "codex"),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  try {
    const { threadId } = await params;
    const bundle = await readThreadContextBundle(request, threadId);
    const before = readString(request.nextUrl.searchParams.get("before")) || null;
    if (before && before.length > 1_000) {
      throw new Error("Thread Recall history ref must contain at most 1,000 characters.");
    }
    const requestedKinds = request.nextUrl.searchParams.getAll("kind");
    const kinds = (requestedKinds.length ? readRecallKinds(requestedKinds) : undefined) ?? THREAD_RECALL_KINDS;
    const records = selectWorkbenchThreadRecallRecords(buildWorkbenchThreadRecallRecords(bundle), kinds);
    return markdownResponse(renderWorkbenchThreadRecallHistoryMarkdown(records, {
      before,
      kinds,
      threadId: bundle.thread.id,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  try {
    const { threadId } = await params;
    const recallRequest = parseRecallRequest(await request.json());
    const bundle = await readThreadContextBundle(request, threadId);
    const records = buildWorkbenchThreadRecallRecords(bundle);
    if (recallRequest.action === "search") {
      const result = searchWorkbenchThreadRecall(records, {
        kinds: recallRequest.kinds ?? THREAD_RECALL_KINDS,
        limit: recallRequest.limit ?? 10,
        query: recallRequest.query,
        before: recallRequest.before ?? null,
      });
      return markdownResponse(renderWorkbenchThreadRecallSearchMarkdown(result, bundle.thread.id));
    }

    const expansion = expandWorkbenchThreadRecall(records, {
      cursor: recallRequest.cursor ?? null,
      ref: recallRequest.ref,
    });
    return markdownResponse(renderWorkbenchThreadRecallExpansionMarkdown(
      expansion,
      bundle.thread.id,
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

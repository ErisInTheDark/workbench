/*
 * Exports:
 * - WorkbenchThreadRecallControllerRequest/WorkbenchThreadRecallControllerOptions: define platform-neutral Thread Recall request and bundle-loading ports. Keywords: thread recall, request, adapter, bundle.
 * - toWorkbenchThreadRecallBundle: adapt one provider context response into the shared recall bundle. Keywords: thread recall, provider, transcript, adapter.
 * - default WorkbenchThreadRecallController: validate, select, search, expand, and render bounded Thread Recall Markdown. Keywords: thread recall, history, search, expansion, markdown.
 */
import type {
  WorkbenchThreadContextBundle,
  WorkbenchThreadContextReadResponse,
  WorkbenchThreadRecallKind,
  WorkbenchThreadRecallRequest,
} from "workbench-shared/types";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import {
  renderWorkbenchThreadRecallExpansionMarkdown,
  renderWorkbenchThreadRecallHistoryMarkdown,
  renderWorkbenchThreadRecallSearchMarkdown,
} from "./thread-context-recall-markdown";
import {
  buildWorkbenchThreadRecallRecords,
  expandWorkbenchThreadRecall,
  searchWorkbenchThreadRecall,
  selectWorkbenchThreadRecallRecords,
} from "./thread-context-recall";

const THREAD_RECALL_KINDS: readonly WorkbenchThreadRecallKind[] = [
  "agent-message",
  "commentary",
  "final-answer",
  "plan",
  "questionnaire",
  "user-message",
  "user-steer",
];

export interface WorkbenchThreadRecallControllerRequest {
  body?: unknown;
  method: "GET" | "POST";
  searchParams: URLSearchParams;
  threadId: string;
}

export interface WorkbenchThreadRecallControllerOptions {
  readBundle(threadId: string, signal: AbortSignal): Promise<WorkbenchThreadContextBundle>;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function markdownResponse(markdown: string) {
  return new Response(markdown, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

function errorResponse(error: unknown) {
  return Response.json({
    error: error instanceof Error ? error.message : "Unable to read Thread Recall.",
  }, {
    headers: { "Cache-Control": "no-store" },
    status: 400,
  });
}

function readOptionalInteger(record: Record<string, unknown>, key: string, maximum: number) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${key} must be an integer between 0 and ${maximum}.`);
  }
  return value as number;
}

function readRecallKinds(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) throw new Error("kinds must contain at least one Thread Recall kind.");
  const allowed = new Set<string>(THREAD_RECALL_KINDS);
  const kinds = Array.from(new Set(value.map(readString)));
  if (kinds.some((kind) => !allowed.has(kind))) {
    throw new Error(`kinds must use only: ${THREAD_RECALL_KINDS.join(", ")}.`);
  }
  return kinds as WorkbenchThreadRecallKind[];
}

function parseRecallRequest(value: unknown): WorkbenchThreadRecallRequest {
  const record = asRecord(value);
  if (!record) throw new Error("A Thread Recall request object is required.");
  const action = readString(record.action);
  if (action === "search") {
    const query = readString(record.query);
    if (!query || query.length > 500) throw new Error("Thread Recall search query must contain 1 to 500 characters.");
    const kinds = readRecallKinds(record.kinds);
    const limit = readOptionalInteger(record, "limit", 50);
    if (limit === 0) throw new Error("Thread Recall search limit must be between 1 and 50.");
    const before = readString(record.before);
    if (before.length > 1_000) throw new Error("Thread Recall search before ref must contain at most 1,000 characters.");
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
    if (!ref || ref.length > 1_000) throw new Error("Thread Recall expand ref must contain 1 to 1,000 characters.");
    const cursor = readString(record.cursor);
    if (cursor.length > 2_000) throw new Error("Thread Recall expansion cursor must contain at most 2,000 characters.");
    return { action, ref, ...(cursor ? { cursor } : {}) };
  }
  throw new Error("Thread Recall action must be search or expand.");
}

export function toWorkbenchThreadRecallBundle(context: WorkbenchThreadContextReadResponse): WorkbenchThreadContextBundle {
  return {
    browseResultEntries: context.browseResultEntries,
    questionnaireEntries: context.questionnaireEntries,
    steerEntries: context.steerEntries,
    thread: toThreadPayload(context.thread, "codex"),
  };
}

export default class WorkbenchThreadRecallController {
  constructor(private readonly options: WorkbenchThreadRecallControllerOptions) {}

  async execute(request: WorkbenchThreadRecallControllerRequest, signal: AbortSignal) {
    try {
      const threadId = readString(request.threadId);
      if (!threadId) throw new Error("Thread Recall requires a threadId.");
      signal.throwIfAborted();
      const recallRequest = request.method === "POST"
        ? parseRecallRequest(await request.body)
        : null;
      const bundle = await this.options.readBundle(threadId, signal);
      signal.throwIfAborted();
      const records = buildWorkbenchThreadRecallRecords(bundle);
      if (request.method === "GET") {
        const before = readString(request.searchParams.get("before")) || null;
        if (before && before.length > 1_000) throw new Error("Thread Recall history ref must contain at most 1,000 characters.");
        const requestedKinds = request.searchParams.getAll("kind");
        const kinds = (requestedKinds.length ? readRecallKinds(requestedKinds) : undefined) ?? THREAD_RECALL_KINDS;
        return markdownResponse(renderWorkbenchThreadRecallHistoryMarkdown(
          selectWorkbenchThreadRecallRecords(records, kinds),
          { before, kinds, threadId: bundle.thread.id },
        ));
      }

      if (!recallRequest) throw new Error("A Thread Recall POST request is required.");
      if (recallRequest.action === "search") {
        const result = searchWorkbenchThreadRecall(records, {
          before: recallRequest.before ?? null,
          kinds: recallRequest.kinds ?? THREAD_RECALL_KINDS,
          limit: recallRequest.limit ?? 10,
          query: recallRequest.query,
        });
        return markdownResponse(renderWorkbenchThreadRecallSearchMarkdown(result, bundle.thread.id));
      }
      const expansion = expandWorkbenchThreadRecall(records, {
        cursor: recallRequest.cursor ?? null,
        ref: recallRequest.ref,
      });
      return markdownResponse(renderWorkbenchThreadRecallExpansionMarkdown(expansion, bundle.thread.id));
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResponse(error);
    }
  }
}

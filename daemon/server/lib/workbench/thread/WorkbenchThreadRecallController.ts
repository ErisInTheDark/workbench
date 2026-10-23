/*
 * Exports:
 * - WorkbenchThreadRecallControllerRequest/WorkbenchThreadRecallControllerOptions: platform-neutral Thread Recall request and history ports.
 * - default WorkbenchThreadRecallController: read or search one thread's narrative through the history engine, recovering
 *   missing turns of the read window from the provider once per request, and render bounded Markdown.
 */
import { z } from "zod";
import { WORKBENCH_THREAD_RECALL_KINDS, type WorkbenchThreadRecallKind } from "workbench-shared/types";
import {
  HistoryQuerySchema,
  readHistoryAnchor,
  type HistoryPage,
  type HistoryQuery,
} from "../../../database/history/history-query-contract.ts";
import { renderThreadRecallHistory, renderThreadRecallSearch, type ThreadRecallWalk } from "./thread-context-recall-markdown.ts";

/** Recovery reads providers turn by turn; a page recovers at most this many, newest first, and reports the rest. */
const MAX_RECOVERED_TURNS = 2;
const DEFAULT_SEARCH_LIMIT = 10;

export interface WorkbenchThreadRecallControllerRequest {
  body?: unknown;
  method: "GET" | "POST";
  searchParams: URLSearchParams;
  threadId: string;
}

export interface WorkbenchThreadRecallControllerOptions {
  queryHistory(query: HistoryQuery): Promise<HistoryPage>;
  /** A null turn bootstraps a thread with no stored history. */
  materializeTurn(threadId: string, turnId: string | null, signal: AbortSignal): Promise<void>;
  /** The stored thread's canonical id and project root, or null when the thread has no stored history yet. */
  readThread(threadId: string): Promise<{ id: string; projectRoot: string } | null>;
  resolveProjectFromCwd(cwd: string): Promise<void>;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function markdownResponse(markdown: string) {
  return new Response(markdown, { headers: { "Cache-Control": "no-store", "Content-Type": "text/markdown; charset=utf-8" } });
}

function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Unable to read Thread Recall." }, {
    headers: { "Cache-Control": "no-store" },
    status: 400,
  });
}

function readKinds(values: readonly string[]) {
  if (!values.length) return null;
  const kinds = [...new Set(values.map(readString))];
  if (kinds.some(kind => !(WORKBENCH_THREAD_RECALL_KINDS as readonly string[]).includes(kind))) {
    throw new Error(`kinds must use only: ${WORKBENCH_THREAD_RECALL_KINDS.join(", ")}.`);
  }
  return kinds as WorkbenchThreadRecallKind[];
}

const SearchBodySchema = z.object({
  action: z.literal("search"),
  query: z.string().trim().min(1).max(500),
  kinds: z.array(z.enum(WORKBENCH_THREAD_RECALL_KINDS)).min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(16_000).optional(),
}).strict();

function issues(error: z.ZodError) {
  return error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

export default class WorkbenchThreadRecallController {
  constructor(private readonly options: WorkbenchThreadRecallControllerOptions) {}

  /** Bootstrap a thread with no stored history, resolve its project like any agent endpoint, and return its stored id. */
  async #prepare(threadId: string, signal: AbortSignal) {
    let stored = await this.options.readThread(threadId);
    if (stored === null) {
      await this.options.materializeTurn(threadId, null, signal);
      signal.throwIfAborted();
      stored = await this.options.readThread(threadId);
    }
    if (stored === null) throw new Error(`Thread Recall could not materialize thread ${threadId}.`);
    await this.options.resolveProjectFromCwd(stored.projectRoot);
    signal.throwIfAborted();
    return stored.id;
  }

  /**
   * Read once; when the window holds never-materialised turns, recover the newest few from the provider and read
   * again. Retention-expired turns are never recovered here: provider recovery can load a whole native session.
   */
  async #readWindow(query: HistoryQuery, signal: AbortSignal) {
    const page = await this.options.queryHistory(query);
    const failures: string[] = [];
    let current = page;
    if (page.gaps.length) {
      for (const turnId of page.gaps.slice(0, MAX_RECOVERED_TURNS)) {
        try {
          await this.options.materializeTurn(query.threads[0]!, turnId, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          failures.push(`turn ${turnId}: ${error instanceof Error ? error.message.slice(0, 200) : "recovery failed"}`);
        }
        signal.throwIfAborted();
      }
      current = await this.options.queryHistory(query);
    }
    const warnings = [
      ...failures.map(failure => `Provider recovery failed for ${failure}.`),
      ...(current.gaps.length ? [`${current.gaps.length} turn(s) in this window are not stored locally yet.`] : []),
      ...(current.expired.length ? [`${current.expired.length} turn(s) in this window expired by retention; only their retained user and assistant text shows. \`wb transcript read --thread <id> --turn <turn> --provider\` recovers one explicitly.`] : []),
    ];
    return { page: current, warnings };
  }

  /** Validate the whole request before any history or provider work. */
  #historyRequest(threadId: string, searchParams: URLSearchParams) {
    const kinds = readKinds(searchParams.getAll("kind"));
    const anchors = (["before", "after", "around"] as const).flatMap(direction => {
      const value = readString(searchParams.get(direction));
      return value ? [{ direction, value }] : [];
    });
    if (anchors.length > 1) throw new Error("Pass at most one of before, after and around.");
    const anchor = anchors[0];
    let walk: ThreadRecallWalk = { direction: "latest" };
    if (anchor) {
      const parsed = readHistoryAnchor(anchor.value);
      walk = { direction: anchor.direction, offset: parsed.offset, ref: parsed.part ? `${parsed.itemId}:${parsed.part}` : parsed.itemId };
    }
    const query = HistoryQuerySchema.parse({
      action: "read", view: "narrative", threads: [threadId], kinds: kinds ?? [],
      ...(anchor ? { [anchor.direction]: anchor.value } : {}),
    });
    return { kinds, query, walk };
  }

  #searchRequest(threadId: string, body: unknown) {
    const parsed = SearchBodySchema.safeParse(body);
    if (!parsed.success) throw new Error(`Invalid Thread Recall search: ${issues(parsed.error)}`);
    const limit = parsed.data.limit ?? DEFAULT_SEARCH_LIMIT;
    const kinds = parsed.data.kinds ?? null;
    const query = HistoryQuerySchema.parse({
      action: "search", view: "narrative", threads: [threadId], query: parsed.data.query, kinds: kinds ?? [], limit,
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    });
    return { kinds, limit, query, text: parsed.data.query };
  }

  async execute(request: WorkbenchThreadRecallControllerRequest, signal: AbortSignal) {
    try {
      const threadId = readString(request.threadId);
      if (!threadId) throw new Error("Thread Recall requires a threadId.");
      signal.throwIfAborted();
      if (request.method === "GET") {
        const { kinds, query, walk } = this.#historyRequest(threadId, request.searchParams);
        const storedId = await this.#prepare(threadId, signal);
        const { page, warnings } = await this.#readWindow({ ...query, threads: [storedId] }, signal);
        return markdownResponse(renderThreadRecallHistory({ kinds, page, threadId: storedId, walk, warnings }));
      }
      const { kinds, limit, query, text } = this.#searchRequest(threadId, await request.body);
      const storedId = await this.#prepare(threadId, signal);
      const page = await this.options.queryHistory({ ...query, threads: [storedId] });
      return markdownResponse(renderThreadRecallSearch({ kinds, limit, page, query: text, threadId: storedId }));
    } catch (error) {
      if (signal.aborted) throw error;
      return errorResponse(error);
    }
  }
}

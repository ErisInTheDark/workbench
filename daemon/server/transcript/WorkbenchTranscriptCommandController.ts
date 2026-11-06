/*
 * Exports:
 * - default WorkbenchTranscriptCommandController: answer `wb transcript` with one history query in the items view per
 *   request, reading what Thread Recall reaches for named threads and the caller's own project otherwise.
 */
import { z } from "zod";
import {
  HistoryCommandQuerySchema,
  HistoryQueryError,
  type HistoryPage,
  type HistoryQuery,
} from "../database/history/history-query-contract";
import { renderTranscriptPage, transcriptPageOutput } from "./transcript-command-markdown";

interface Options {
  materializeTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<void>;
  read(query: HistoryQuery): Promise<HistoryPage>;
  /** The caller's project; fails when its folder belongs to none. */
  resolveProjectId(cwd: string): Promise<string>;
  /** Fails for a thread Thread Recall would refuse. */
  requireThreadProject(threadId: string): Promise<void>;
}

export default class WorkbenchTranscriptCommandController {
  constructor(private readonly options: Options) {}

  /** Only managed callers narrow: another daemon's caller names granted threads and a person at a terminal reads everything. */
  async #scoped(query: HistoryQuery, cwd: string, callerThreadId: string | null, allProjects: boolean) {
    if (callerThreadId === null) return query;
    try {
      for (const threadId of query.threads) await this.options.requireThreadProject(threadId);
      if (query.threads.length || query.project || allProjects) return query;
      return { ...query, project: await this.options.resolveProjectId(cwd) };
    } catch (error) {
      throw new HistoryQueryError(error instanceof Error ? error.message : "This transcript is out of reach.");
    }
  }

  async execute(input: object, signal: AbortSignal) {
    const parsed = HistoryCommandQuerySchema.safeExtend({
      cwd: z.string().min(1).max(4096), callerThreadId: z.string().min(1).max(4096).nullable(),
    }).safeParse(input);
    if (!parsed.success) return new Response(parsed.error.issues.map(issue => issue.message).join("\n").slice(0, 2000), { status: 400 });
    const { cwd, callerThreadId, provider, allProjects, ...query } = parsed.data;
    try {
      signal.throwIfAborted();
      const scoped = await this.#scoped(query, cwd, callerThreadId, allProjects);
      signal.throwIfAborted();
      if (provider) {
        await this.options.materializeTurn(query.threads[0]!, query.turn!, signal);
        signal.throwIfAborted();
      }
      const page = await this.options.read(scoped);
      signal.throwIfAborted();
      const headers = { "Cache-Control": "no-store" };
      const written = { ...query, allProjects };
      return query.json
        ? Response.json(transcriptPageOutput(written, page), { headers })
        : new Response(renderTranscriptPage(written, page, cwd), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (HistoryQueryError.is(error)) return new Response(`${error.message.slice(0, 2000)}\n`, { status: 400 });
      const detail = (error instanceof Error ? error.message : "non-error failure")
        .replace(/(["'`])[\s\S]*?\1/gu, "[value]")
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/gu, "[path]")
        .replace(/(^|\s)\/[^\r\n]*/gu, "$1[path]")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500);
      console.warn("[transcript-query] stored transcript query failed", { action: query.action, detail });
      return new Response("Stored transcript query failed. The owning database/command logs contain the failure boundary.\n", { status: 500 });
    }
  }
}

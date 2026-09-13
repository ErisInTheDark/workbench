/*
 * Exports:
 * - default WorkbenchTranscriptCommandController: own admitted stored-history scans and CLI responses.
 */
import path from "node:path";
import { z } from "zod";
import { TranscriptQuerySchema, TranscriptQueryError, type TranscriptQuery, type TranscriptQueryPage } from "./database/transcript/transcript-query-contract";
import { renderTranscriptPage, transcriptPageOutput } from "./transcript-command-markdown";

interface Options {
  projectRoot: string;
  read(query: TranscriptQuery): Promise<TranscriptQueryPage>;
}

export default class WorkbenchTranscriptCommandController {
  constructor(private readonly options: Options) {}
  async execute(input: object, signal: AbortSignal) {
    const parsed = TranscriptQuerySchema.safeExtend({
      cwd: z.string().min(1).max(4096), callerThreadId: z.string().min(1).max(4096).nullable(),
    }).safeParse(input);
    if (!parsed.success) return new Response(parsed.error.issues.map(issue => issue.message).join("\n").slice(0, 2000), { status: 400 });
    const { cwd, callerThreadId, ...query } = parsed.data;
    const normalized = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (callerThreadId !== null && normalized(cwd) !== normalized(this.options.projectRoot)) {
      return new Response("Managed threads can query transcripts only from the running Workbench repository root.\n", { status: 403 });
    }
    try {
      signal.throwIfAborted();
      const page = await this.options.read(query);
      signal.throwIfAborted();
      while (query.action === "search" && page.rows.length < query.limit && page.nextCursor) {
        const next = await this.options.read({ ...query, cursor: page.nextCursor, limit: query.limit - page.rows.length });
        signal.throwIfAborted();
        if (next.nextCursor === page.nextCursor) throw new Error("Transcript query did not advance its cursor.");
        page.rows.push(...next.rows);
        page.scanned += next.scanned;
        page.nextCursor = next.nextCursor;
      }
      const headers = { "Cache-Control": "no-store" };
      return query.json
        ? Response.json(transcriptPageOutput(query, page), { headers })
        : new Response(renderTranscriptPage(query, page, cwd), { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8" } });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof TranscriptQueryError) return new Response(`${error.message.slice(0, 2000)}\n`, { status: 400 });
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

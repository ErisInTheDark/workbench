/*
 * Exports:
 * - default WorkbenchMarkdownTocController: own cancellable Markdown reads and heading-range responses. Keywords: toc, markdown, headings, ranges, files, cancellation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { WorkbenchTocExecutionRequestSchema } from "../lib/workbench/commands/toc-command-definition";
import { listMarkdownHeadingRangeLines } from "../lib/workbench/markdown/markdown-heading-ranges";

function readFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { message: "Markdown file was not found.\n", status: 400 };
  }
  if (code === "EISDIR") {
    return { message: "Markdown file path must identify a file.\n", status: 400 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: `Markdown file could not be read: ${message.slice(0, 500)}\n`, status: 500 };
}

export default class WorkbenchMarkdownTocController {
  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchTocExecutionRequestSchema.safeParse(input);
    if (!request.success) return new Response("A valid Markdown toc request is required.\n", { status: 400 });
    if (signal.aborted) throw signal.reason;

    let markdown: string;
    try {
      markdown = await readFile(path.resolve(request.data.cwd, request.data.file), { encoding: "utf8", signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = readFailure(error);
      return new Response(failure.message, { status: failure.status });
    }
    if (signal.aborted) throw signal.reason;

    const lines = listMarkdownHeadingRangeLines(markdown);
    return new Response(lines.length ? `${lines.join("\n")}\n` : "");
  }
}

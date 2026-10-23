/*
 * Exports:
 * - default WorkbenchRipgrepController: own wb rg requests; parse rg-style args, hydrate lazy roots, then run one cancellable
 *   search worker that enumerates gitignore-aware candidates and searches them off this event loop.
 */
import { Worker } from "node:worker_threads";

import { parseRipgrepArguments, RIPGREP_HELP_TEXT } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import { formatRipgrepTypeList } from "workbench-shared/workbench/ripgrep/ripgrep-file-types";

import { WorkbenchRipgrepExecutionRequestSchema } from "../lib/workbench/commands/ripgrep-command-definition";
import { prefetchRipgrepRoots, type RipgrepHydrate } from "../lib/workbench/ripgrep/ripgrep-candidates";
import type { RipgrepSearchInput, RipgrepSearchResult } from "../lib/workbench/ripgrep/ripgrep-search";
import { logError } from "../process-helpers";

interface WorkbenchRipgrepControllerOptions {
  workerUrl?: URL;
  /** Bulk-fetches lazily loaded roots, such as virtual repository mounts, before they are walked. */
  hydrate?: RipgrepHydrate;
  logError?(message: string): void;
  /** Observes worker startup; lets tests cancel while the worker is live. */
  onWorkerOnline?(): void;
}

function rejected(message: string) {
  return new Response(`${message.trimEnd()}\n`, { status: 400 });
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export default class WorkbenchRipgrepController {
  private readonly workerUrl: URL;
  private readonly logError: (message: string) => void;

  constructor(private readonly options: WorkbenchRipgrepControllerOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL("../lib/workbench/ripgrep/ripgrep-worker-bootstrap.mjs", import.meta.url);
    this.logError = options.logError ?? (message => logError("wb-rg", message));
  }

  async execute(input: object, signal: AbortSignal): Promise<Response> {
    const request = WorkbenchRipgrepExecutionRequestSchema.safeParse(input);
    if (!request.success) return rejected("A valid wb rg request is required.");
    signal.throwIfAborted();
    const parsed = parseRipgrepArguments(request.data.args);
    if (parsed.kind === "rejected") return rejected(parsed.message);
    const { query } = parsed;
    if (query.mode === "help") return new Response(RIPGREP_HELP_TEXT);
    if (query.mode === "type-list") return new Response(formatRipgrepTypeList());

    try {
      const { cwd } = request.data;
      const prefetchWarnings = this.options.hydrate ? await prefetchRipgrepRoots(query, cwd, signal, this.options.hydrate) : {};
      const result = await this.search({ query, cwd, prefetchWarnings }, signal);
      if (result.kind === "invalid") return rejected(result.message);
      if (result.kind === "failed") throw new Error(result.message);
      return new Response(result.output);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = errorMessage(error);
      this.logError(`search failed: ${message}`);
      return rejected(`wb rg could not search: ${message}`);
    }
  }

  private search(input: RipgrepSearchInput, signal: AbortSignal) {
    return new Promise<RipgrepSearchResult>((resolve, reject) => {
      signal.throwIfAborted();
      const worker = new Worker(this.workerUrl, { workerData: input });
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        worker.terminate().catch((error: unknown) => this.logError(`worker termination failed: ${errorMessage(error)}`));
        finish();
      };
      const onAbort = () => settle(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("online", () => this.options.onWorkerOnline?.());
      worker.once("message", (result: RipgrepSearchResult) => settle(() => resolve(result)));
      worker.once("error", error => settle(() => reject(error)));
      worker.once("exit", code => settle(() => reject(new Error(`search worker exited early with code ${code}`))));
    });
  }
}

/*
 * Exports:
 * - Gpt5TokenWorkerMessage: what the token worker posts back.
 * - Gpt5TokenDeadlineError: the worker ran past its deadline and was terminated.
 * - measureGpt5Tokens: measure untrusted texts in order, inline when long runs are few, otherwise on a worker with a deadline.
 */
import { Worker } from "node:worker_threads";

import Gpt5TextTokens, { type Gpt5TokenMeasure } from "./gpt-5-text-tokens";

export type Gpt5TokenWorkerMessage =
  | { kind: "completed"; measures: Gpt5TokenMeasure[] }
  | { kind: "failed"; message: string };

export class Gpt5TokenDeadlineError extends Error {
  constructor() {
    super("This text has too many long unbroken runs to count in time.");
    this.name = "Gpt5TokenDeadlineError";
  }
}

/** The worst measured input, non-repeating CJK, costs tens of microseconds per character: under 100ms on the event loop at this size. */
const INLINE_LONG_RUN_CHARS = 2_000;
const WORKER_DEADLINE_MS = 30_000;
const WORKER_URL = new URL("./gpt-5-token-worker-bootstrap.mjs", import.meta.url);

function measureOnWorker(texts: readonly string[], signal: AbortSignal | undefined, deadlineMs: number) {
  return new Promise<Gpt5TokenMeasure[]>((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(WORKER_URL, { workerData: { texts } });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch((error: unknown) => console.error(`[tokens] worker termination failed: ${error instanceof Error ? error.message : String(error)}`));
      finish();
    };
    const deadline = setTimeout(() => settle(() => reject(new Gpt5TokenDeadlineError())), deadlineMs);
    const onAbort = () => settle(() => reject(signal!.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: Gpt5TokenWorkerMessage) => settle(() => (
      message.kind === "completed" ? resolve(message.measures) : reject(new Error(message.message))
    )));
    worker.once("error", error => settle(() => reject(error)));
    worker.once("exit", code => settle(() => reject(new Error(`Token worker exited early with code ${code}.`))));
  });
}

export async function measureGpt5Tokens(
  texts: readonly string[],
  options: { deadlineMs?: number; signal?: AbortSignal | undefined } = {},
): Promise<Gpt5TokenMeasure[]> {
  const longRunChars = texts.reduce((sum, text) => sum + Gpt5TextTokens.longRunChars(text), 0);
  return longRunChars <= INLINE_LONG_RUN_CHARS
    ? texts.map(Gpt5TextTokens.measure)
    : await measureOnWorker(texts, options.signal, options.deadlineMs ?? WORKER_DEADLINE_MS);
}

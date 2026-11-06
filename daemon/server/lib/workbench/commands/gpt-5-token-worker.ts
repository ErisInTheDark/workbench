/*
 * No exports. Worker entry: measure the texts in workerData and post a Gpt5TokenWorkerMessage.
 */
import { parentPort, workerData } from "node:worker_threads";

import Gpt5TextTokens from "./gpt-5-text-tokens";
import type { Gpt5TokenWorkerMessage } from "./gpt-5-token-measure";

const port = parentPort;
if (!port) throw new Error("gpt-5-token-worker must run inside a worker thread.");

let message: Gpt5TokenWorkerMessage;
try {
  message = { kind: "completed", measures: (workerData as { texts: string[] }).texts.map(Gpt5TextTokens.measure) };
} catch (error) {
  message = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}
port.postMessage(message);

/*
 * No exports. Worker entry: run one wb rg search from workerData and post its RipgrepSearchResult.
 */
import { parentPort, workerData } from "node:worker_threads";

import { searchRipgrepFiles, type RipgrepSearchInput, type RipgrepSearchResult } from "./ripgrep-search";

const port = parentPort;
if (!port) throw new Error("ripgrep-worker must run inside a worker thread.");

void searchRipgrepFiles(workerData as RipgrepSearchInput).then(
  result => port.postMessage(result),
  (error: unknown) => port.postMessage({
    kind: "failed",
    message: error instanceof Error ? error.message : String(error),
  } satisfies RipgrepSearchResult),
);

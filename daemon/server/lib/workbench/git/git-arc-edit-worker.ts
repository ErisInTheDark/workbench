/*
 * No exports. Worker entry: run one edit session's operations from workerData and post a GitArcEditWorkerMessage.
 */
import { parentPort, workerData } from "node:worker_threads";

import { runGitArcEditOperations, type GitArcEditWorkInput } from "./git-arc-edit-operations";
import type { GitArcEditWorkerMessage } from "./GitArcEditPlanner";

const port = parentPort;
if (!port) throw new Error("git-arc-edit-worker must run inside a worker thread.");

let message: GitArcEditWorkerMessage;
try {
  message = { kind: "completed", result: runGitArcEditOperations(workerData as GitArcEditWorkInput) };
} catch (error) {
  message = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}
port.postMessage(message);

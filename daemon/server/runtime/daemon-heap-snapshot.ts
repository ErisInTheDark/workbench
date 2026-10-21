/*
 * Exports:
 * - writeDaemonHeapSnapshot: write one V8 heap snapshot of this daemon process under the data root's diagnostics folder, logging progress while it runs.
 */
import { mkdirSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { Worker } from "node:worker_threads";
import { dim, green, yellow } from "workbench-shared/process/terminal-style";

const PROGRESS_INTERVAL_MS = 2_000;

/**
 * Runs on its own event loop while the main thread is frozen inside the snapshot, writing straight to fd 1 so
 * the host's quiet-daemon watchdog keeps seeing output. Plain JS: it is evaluated, not compiled.
 */
const PROGRESS_WORKER = `
const { statSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { target, startedAt, intervalMs, dimOpen, reset } = workerData;
setInterval(() => {
  let size = 0;
  try { size = statSync(target).size; } catch {}
  const phase = size ? "writing " + Math.round(size / 1048576) + "MB" : "scanning the heap";
  writeSync(1, " DBG Heap snapshot running " + ((Date.now() - startedAt) / 1000).toFixed(1) + "s " + dimOpen + "(" + phase + ")" + reset + "\\n");
}, intervalMs);
`;

function seconds(ms: number) {
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** Uses the native snapshot writer; the in-process inspector's snapshot path crashed the daemon with an access violation. */
export async function writeDaemonHeapSnapshot(
  dataRootPath: string,
  writeLine: (line: string) => void = line => { writeSync(process.stdout.fd, `${line}\n`); },
  intervalMs = PROGRESS_INTERVAL_MS,
) {
  const directory = path.join(dataRootPath, "daemon", "diagnostics");
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `heap-${new Date().toISOString().replace(/[:.]/gu, "-")}.heapsnapshot`);
  const startedAt = Date.now();
  const progress = new Worker(PROGRESS_WORKER, {
    eval: true,
    workerData: { target, startedAt, intervalMs, dimOpen: "\u001b[2m", reset: "\u001b[0m" },
  });
  try {
    // The worker must be running before the main thread freezes, or it could not start until afterwards.
    await new Promise<void>((resolve, reject) => {
      progress.once("online", resolve);
      progress.once("error", reject);
    });
    writeLine(` DBG Heap snapshot ${yellow("started")} ${dim("(the daemon is paused until it finishes)")}`);
    const written = writeHeapSnapshot(target);
    const pauseMs = Date.now() - startedAt;
    const bytes = statSync(written).size;
    writeLine(` DBG Heap snapshot ${green("finished")} after ${seconds(pauseMs)} ${dim(`(${Math.round(bytes / 1_048_576)}MB, ${written})`)}`);
    return { path: written, bytes, pauseMs };
  } finally {
    await progress.terminate();
  }
}

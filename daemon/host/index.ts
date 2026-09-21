/*
 * No exports. Start the independent host only inside its acknowledged supervision session.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import WorkbenchProcessLogger from "../../shared/process/WorkbenchProcessLogger.ts";
import WorkbenchRotatingLog from "../../shared/process/WorkbenchRotatingLog.ts";

import WorkbenchService from "./WorkbenchService.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Windows' native supervisor owns persistence; Linux's Node host owns it here.
const fileLog = process.platform === "win32" ? null : new WorkbenchRotatingLog(path.join(root, ".workbench", "logs"), "workbench-host");
const write = (text: string, error = false) => {
  (error ? process.stderr : process.stdout).write(text);
  fileLog?.write(text);
};
const logger = new WorkbenchProcessLogger({
  writeOutput: text => write(text),
  writeError: text => write(text, true),
});
process.once("exit", () => fileLog?.close());

async function main() {
  const session = process.env.WORKBENCH_SERVICE_SESSION;
  if (!session) throw new Error("Start the managed host with wb connect or pnpm dev.");
  const service = new WorkbenchService({
    root, session,
    warn: message => logger.error("host", message),
    restart: fatal => setImmediate(() => stop("supervisor replacement", fatal ? 78 : 1)),
    stop: () => stop("explicit shutdown", 0),
    writeLog: write,
  });
  let stopping: Promise<void> | null = null;
  const stop = (signal: string, exitCode: number) => {
    if (stopping) return;
    if (process.env.WORKBENCH_FOREGROUND_PIPE === "1") process.stdin.destroy();
    process.exitCode = exitCode;
    stopping ??= service.close().catch((error) => {
      logger.error("host", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      if (exitCode === 0) process.exitCode = 78;
    });
  };
  process.once("SIGHUP", () => stop("SIGHUP", 0));
  process.once("SIGINT", () => stop("SIGINT", 0));
  process.once("SIGTERM", () => stop("SIGTERM", 0));
  if (process.env.WORKBENCH_FOREGROUND_PIPE === "1") {
    process.stdin.once("end", () => stop("foreground owner closed", 0));
    process.stdin.once("error", error => {
      logger.error("host", `foreground input failed: ${error.message}`);
      stop("foreground input failed", 0);
    });
    process.stdin.resume();
  }
  await service.start();
  process.stdout.write("workbench-host-ready\n");
  if (process.env.WORKBENCH_FOREGROUND_PIPE === "1") {
    process.stdout.write(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: process.pid })}\n`);
  }
}

void main().catch((error) => {
  logger.error("host", `failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 78;
});

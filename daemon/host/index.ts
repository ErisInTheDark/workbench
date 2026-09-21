/*
 * No exports. Start the independent host only inside its acknowledged supervision session.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import WorkbenchProcessLogger from "../../shared/process/WorkbenchProcessLogger.ts";

import WorkbenchService from "./WorkbenchService.ts";

const logger = new WorkbenchProcessLogger();

async function main() {
  const session = process.env.WORKBENCH_SERVICE_SESSION;
  if (!session) throw new Error("Start the managed host with wb connect or pnpm dev.");
  const service = new WorkbenchService({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), session,
    warn: message => logger.error("host", message),
    restart: fatal => setImmediate(() => stop("supervisor replacement", fatal ? 78 : 1)),
  });
  let stopping: Promise<void> | null = null;
  const stop = (signal: string, exitCode: number) => {
    process.exitCode = exitCode;
    stopping ??= service.close().catch((error) => {
      logger.error("host", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      if (exitCode === 0) process.exitCode = 1;
    });
  };
  process.once("SIGHUP", () => stop("SIGHUP", 0));
  process.once("SIGINT", () => stop("SIGINT", 0));
  process.once("SIGTERM", () => stop("SIGTERM", 0));
  await service.start();
  process.stdout.write("workbench-host-ready\n");
}

void main().catch((error) => {
  logger.error("host", `failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 78;
});

/*
 * No exports. Foreground entry starts the standalone orchestrator runner and forwards process signals to its lifecycle owner.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import WorkbenchProcessLogger from "../shared/process/WorkbenchProcessLogger.ts";

import WorkbenchOrchestratorRunner from "./WorkbenchOrchestratorRunner.ts";

const logger = new WorkbenchProcessLogger();

function readDryRun(arguments_: readonly string[]) {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--dry-run") return true;
  throw new Error("Usage: pnpm dev [--dry-run]");
}

async function main() {
  const projectRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runner = new WorkbenchOrchestratorRunner({ projectRootPath });
  let stopping: Promise<void> | null = null;
  const stop = (signal: string, exitCode: number) => {
    process.exitCode = exitCode;
    stopping ??= runner.stop(`Orchestrator runner interrupted by ${signal}.`).catch((error) => {
      logger.error("runner", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGHUP", () => stop("SIGHUP", 129));
  process.once("SIGINT", () => stop("SIGINT", 130));
  process.once("SIGTERM", () => stop("SIGTERM", 143));
  await runner.run({ dryRun: readDryRun(process.argv.slice(2)) });
  await stopping;
}

void main().catch((error) => {
  logger.error("runner", `failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

/*
 * No exports. Foreground entry configures the standalone Workbench app and forwards process signals to its lifecycle owner.
 */
import WorkbenchApp from "./WorkbenchApp.ts";
import WorkbenchAppLogger from "./WorkbenchAppLogger.ts";
import WorkbenchAppProcessProtocol from "./WorkbenchAppProcessProtocol.ts";
import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";
import WorkbenchFrontendServer from "./WorkbenchFrontendServer.ts";
import WorkbenchAppStateRepository from "./state/WorkbenchAppStateRepository.ts";
import WorkbenchAppRuntime from "./runtime/WorkbenchAppRuntime.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logger = new WorkbenchAppLogger();

function configuredPort(value: string | undefined) {
  if (!value?.trim()) return 0;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("WORKBENCH_APP_PORT must be an integer from 0 through 65535.");
  }
  return port;
}

function legacyOrigin() {
  return process.env.WORKBENCH_LEGACY_ORIGIN?.trim()
    || process.env.NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN?.trim()
    || `http://127.0.0.1:${process.env.PORT?.trim() || "3002"}`;
}

async function main() {
  const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const createCompiler = () => new WorkbenchFrontendCompiler({
    logger,
    onDiagnostic: (message) => logger.error("tailwind", message),
    repositoryRootPath,
  });
  const outputDirectoryPath = createCompiler().outputDirectoryPath;
  const app = new WorkbenchApp({
    createRuntime: () => new WorkbenchAppRuntime({
      createCompiler,
      createDatabase: () => new WorkbenchAppStateRepository(),
      legacyOrigin: legacyOrigin(),
      logger,
      outputDirectoryPath,
      repositoryRootPath,
    }),
    createServer: (runtime) => new WorkbenchFrontendServer({
      hostname: process.env.WORKBENCH_APP_HOST?.trim() || "0.0.0.0",
      onDiagnostic: (message) => logger.error("http", message),
      port: configuredPort(process.env.WORKBENCH_APP_PORT),
      requests: runtime,
    }),
  });
  const result = await app.start();
  if (result.kind === "already-running") {
    logger.line("app", "already running");
    if (process.env.WORKBENCH_DESKTOP_PROTOCOL === "1") {
      new WorkbenchAppProcessProtocol({
        onQuit: async () => {},
      }).announceAlreadyRunning();
    }
    return;
  }
  logger.line("app", `listening at ${result.address.url}`);

  let closing: Promise<void> | null = null;
  let protocol: WorkbenchAppProcessProtocol | null = null;
  const close = () => {
    closing ??= app.close()
      .then(() => protocol?.dispose())
      .catch((error) => {
        logger.error("app", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    return closing;
  };
  if (process.env.WORKBENCH_DESKTOP_PROTOCOL === "1") {
    protocol = new WorkbenchAppProcessProtocol({
      onDiagnostic: (message) => logger.error("app", message),
      onQuit: close,
    });
    protocol.start();
    protocol.announceReady(result.address.url);
  }
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch((error) => {
  logger.error("app", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

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
  if (!value?.trim()) return null;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("WORKBENCH_APP_PORT must be an integer from 0 through 65535.");
  }
  return port;
}

async function main() {
  const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const createCompiler = () => new WorkbenchFrontendCompiler({
    logger,
    onDiagnostic: (message) => logger.error("tailwind", message),
    repositoryRootPath,
  });
  const outputDirectoryPath = createCompiler().outputDirectoryPath;
  let protocol: WorkbenchAppProcessProtocol | null = null;
  const app = new WorkbenchApp({
    createRuntime: (appPort) => new WorkbenchAppRuntime({
      appPort,
      createCompiler,
      createDatabase: () => new WorkbenchAppStateRepository(),
      logger,
      outputDirectoryPath,
      repositoryRootPath,
    }),
    createServer: (runtime, port) => new WorkbenchFrontendServer({
      hostname: process.env.WORKBENCH_APP_HOST?.trim() || "0.0.0.0",
      onDiagnostic: (message) => logger.error("http", message),
      port,
      requests: runtime,
    }),
    environmentPort: configuredPort(process.env.WORKBENCH_APP_PORT),
    onAddressChange: (address) => protocol?.announceReady(address.url),
    onDiagnostic: (message) => logger.error("app", message),
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

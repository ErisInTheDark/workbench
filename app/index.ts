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
import { readWorkbenchAppCommandLine } from "./app-command-line.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logger = new WorkbenchAppLogger();

async function main() {
  const commandLine = readWorkbenchAppCommandLine();
  const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const desktopProtocolEnabled = process.env.WORKBENCH_DESKTOP_PROTOCOL === "1";
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
      ...(desktopProtocolEnabled
        ? {
            requestProcessRestart: () => {
              if (!protocol) throw new Error("Full app restart requires the Workbench desktop tray.");
              protocol.requestRestart();
            },
          }
        : {}),
    }),
    createServer: (runtime, port) => new WorkbenchFrontendServer({
      hostname: process.env.WORKBENCH_APP_HOST?.trim() || "0.0.0.0",
      onDiagnostic: (message) => logger.error("http", message),
      port,
      requests: runtime,
    }),
    environmentPort: commandLine.port,
    onAddressChange: (address) => protocol?.announceReady(address.url, false),
    onDiagnostic: (message) => logger.error("app", message),
  });
  const result = await app.start();
  if (result.kind === "already-running") {
    logger.line("app", "already running");
    if (desktopProtocolEnabled) {
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
  if (desktopProtocolEnabled) {
    protocol = new WorkbenchAppProcessProtocol({
      onDiagnostic: (message) => logger.error("app", message),
      onQuit: close,
    });
    protocol.start();
    protocol.announceReady(result.address.url, result.portSource === "random");
  }
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

void main().catch((error) => {
  logger.error("app", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

/*
 * Exports:
 * - default startWorkbenchAppProcess: configure the standalone app and forward process signals to its lifecycle owner.
 */
import WorkbenchApp from "./WorkbenchApp.ts";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import WorkbenchAppProcessProtocol from "./WorkbenchAppProcessProtocol.ts";
import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";
import WorkbenchFrontendServer from "./WorkbenchFrontendServer.ts";
import WorkbenchAppRuntime from "./runtime/WorkbenchAppRuntime.ts";
import { readWorkbenchAppCommandLine } from "./app-command-line.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import WorkbenchAppControl from "./WorkbenchAppControl.ts";

const processLogger = new WorkbenchProcessLogger();

async function main() {
  const commandLine = readWorkbenchAppCommandLine();
  const configuredHostname = process.env.WORKBENCH_APP_HOST?.trim();
  const hostname = !configuredHostname || configuredHostname === "localhost" ? "127.0.0.1" : configuredHostname;
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("WORKBENCH_APP_HOST must be loopback; use Networking settings for tailnet access.");
  }
  const repositoryRootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const desktopProtocolEnabled = process.env.WORKBENCH_DESKTOP_PROTOCOL === "1";
  const createCompiler = (
    logger: WorkbenchProcessLogger,
    readReactDevelopmentMode: () => boolean,
  ) => new WorkbenchFrontendCompiler({
    logger,
    onDiagnostic: (message) => logger.error("app", `tailwind ${message}`),
    readReactDevelopmentMode,
    repositoryRootPath,
  });
  const outputDirectoryPath = createCompiler(processLogger, () => false).outputDirectoryPath;
  let protocol: WorkbenchAppProcessProtocol | null = null;
  const control = new WorkbenchAppControl({
    endpointPath: path.join(resolveWorkbenchDataRoot(), "app", "runtime.json"),
    root: repositoryRootPath,
    warn: message => processLogger.error("app", message),
    quit: () => {
      if (desktopProtocolEnabled) {
        if (!protocol) throw new Error("Desktop Quit is not ready.");
        protocol.requestQuit();
      } else void close();
    },
  });
  const app = new WorkbenchApp({
    createRuntime: (appPort) => new WorkbenchAppRuntime({
      appPort,
      createCompiler,
      createDatabase: (Repository) => new Repository(),
      logger: processLogger,
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
      hostname,
      onDiagnostic: (message) => processLogger.error("app", `http ${message}`),
      port,
      requests: {
        handleRequest: async (request, response) => {
          if (!control.handle(request, response)) await runtime.handleRequest(request, response);
        },
      },
    }),
    environmentPort: commandLine.port,
    onAddressChange: async address => {
      await control.publish(address.url);
      protocol?.announceReady(address.url, false);
    },
    onDiagnostic: (message) => processLogger.error("app", message),
  });
  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= control.close().finally(() => app.close())
      .then(() => protocol?.dispose())
      .catch((error) => {
        processLogger.error("app", `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    return closing;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  const result = await app.start();
  if (result.kind === "already-running") {
    processLogger.line("app", "already running");
    if (desktopProtocolEnabled) {
      new WorkbenchAppProcessProtocol({
        onQuit: async () => {},
      }).announceAlreadyRunning();
    }
    return;
  }
  processLogger.line("app", `listening at ${result.address.url}`);

  if (desktopProtocolEnabled) {
    protocol = new WorkbenchAppProcessProtocol({
      onDiagnostic: (message) => processLogger.error("app", message),
      onQuit: close,
    });
    protocol.start();
    protocol.announceReady(result.address.url, result.portSource === "random");
  }
  await control.publish(result.address.url);
}

export default function startWorkbenchAppProcess() {
  return main().catch((error) => {
    processLogger.error("app", `failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

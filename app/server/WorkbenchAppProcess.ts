/*
 * Exports:
 * - default startWorkbenchAppProcess: configure the standalone app and forward process signals to its lifecycle owner.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import { describeErrorCauseChain } from "workbench-shared/process/error-cause-chain";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root.ts";
import WorkbenchApp from "./WorkbenchApp.ts";
import WorkbenchAppControl from "./WorkbenchAppControl.ts";
import WorkbenchAppProcessProtocol from "./WorkbenchAppProcessProtocol.ts";
import WorkbenchFrontendServer from "./WorkbenchFrontendServer.ts";
import { readWorkbenchAppCommandLine } from "./app-command-line.ts";
import WorkbenchAppRuntime from "./runtime/WorkbenchAppRuntime.ts";
import resolveWorkbenchRuntimeRoot from "./workbench-runtime-root.ts";

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
  const outputDirectoryPath = path.join(resolveWorkbenchRuntimeRoot(repositoryRootPath), "frontend");
  let protocol: WorkbenchAppProcessProtocol | null = null;
  let runtime: WorkbenchAppRuntime | null = null;
  // The tray learns the chosen browser address after readiness and whenever networking changes it.
  const announceLaunchUrl = () => {
    const url = runtime?.readLaunchUrl();
    if (!protocol || !url) return;
    try { protocol.announceLaunchUrl(url); }
    catch (error) { processLogger.error("app", `launch URL announcement failed: ${describeErrorCauseChain(error)}`); }
  };
  const control = new WorkbenchAppControl({
    endpointPath: path.join(resolveWorkbenchDataRoot(), "app", "runtime.json"),
    root: repositoryRootPath,
    warn: message => processLogger.error("app", message),
    readRuntime: () => runtime?.readControlRuntime() ?? null,
    subscribeRuntime: listener => runtime?.subscribeControlRuntime(listener) ?? (() => {}),
    reloadAll: () => runtime?.admitReloadAll() ?? null,
    pull: reload => runtime?.admitPull(reload) ?? null,
    readLaunchUrl: () => runtime?.readLaunchUrl() ?? null,
    quit: () => {
      if (desktopProtocolEnabled) {
        if (!protocol) throw new Error("Desktop Quit is not ready.");
        protocol.requestQuit();
      } else void close();
    },
  });
  const app = new WorkbenchApp({
    createRuntime: (appPort) => {
      const created = new WorkbenchAppRuntime({
        appPort,
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
      });
      created.subscribeLaunchUrl(announceLaunchUrl);
      runtime = created;
      return created;
    },
    createServer: (runtime, port) => new WorkbenchFrontendServer({
      hostname,
      onDiagnostic: (message) => processLogger.error("app", `http ${message}`),
      port,
      requests: {
        handleRequest: async (request, response) => {
          if (!control.handle(request, response)) await runtime.handleRequest(request, response);
        },
        handleUpgrade: async (request, socket, head) => await runtime.handleUpgrade(request, socket, head),
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
        processLogger.error("app", `shutdown failed: ${describeErrorCauseChain(error)}`);
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
    announceLaunchUrl();
  }
  await control.publish(result.address.url);
}

export default function startWorkbenchAppProcess() {
  return main().catch((error) => {
    processLogger.error("app", `failed to start: ${error instanceof Error ? `${error.stack}` : String(error)}`);
    process.exitCode = 1;
  });
}

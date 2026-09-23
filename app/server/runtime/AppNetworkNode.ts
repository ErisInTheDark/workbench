/*
 * Default export:
 * - AppNetworkNode: own the app's private host session and local listener subscriptions.
 */
import path from "node:path";
import ReloadableNode from "workbench-shared/reload/ReloadableNode";
import WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import WorkbenchServiceLauncher from "../../../daemon/host/WorkbenchServiceLauncher.ts";
import WorkbenchServiceStartup from "../../../daemon/host/WorkbenchServiceStartup.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppHttpNode from "./AppHttpNode.ts";

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
  access: "operator",
  children: [AppHttpNode],
  create: (context, build) => {
    const database = build.get("database");
    const logger = build.get("logger");
    const dataRoot = path.dirname(path.dirname(database.databasePath));
    const endpointPath = path.join(dataRoot, "service", "runtime.json");
    const launcher = new WorkbenchServiceLauncher({
      root: context.repositoryRootPath, endpointPath,
      startup: new WorkbenchServiceStartup({ root: context.repositoryRootPath, dataRoot }),
      warn: message => logger.error("app", `network ${message}`),
    });
    const network = (context.createNetwork ?? (options => new WorkbenchNetworkController(options)))({
      endpointPath,
      ensure: async signal => { await launcher.ensure(signal); },
      wakeLocal: !process.env.WORKBENCH_CODEX_APP_SERVER_URL?.trim(),
      warn: message => logger.error("app", `network ${message}`),
      appPort: context.appPort,
      privateIssue: () => {
        const configured = process.env.WORKBENCH_CODEX_APP_SERVER_URL?.trim();
        if (!configured) return null;
        try {
          if (new URL(configured).protocol === "wss:") return null;
        } catch {
          return "WORKBENCH_CODEX_APP_SERVER_URL is invalid; correct the override before enabling private HTTPS.";
        }
        return "Private HTTPS cannot use an insecure WORKBENCH_CODEX_APP_SERVER_URL. Remove the override or configure a trusted wss:// endpoint.";
      },
      readTarget: () => {
        const app = context.appPort.current?.();
        if (!app) return null;
        return { appOrigin: app.appOrigin };
      },
    });
    let unsubscribe: (() => void) | undefined;
    const dispose = async () => {
      unsubscribe?.();
      const results = await Promise.allSettled([network.close(), launcher.close()]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Networking disposal failed.");
    };
    return {
      beginHandoff: () => ({
        waitForIdle: () => network.suspend(),
        expire: () => {},
        detach: () => undefined,
        resume: () => network.start(),
        commit: dispose,
      }),
      detachForReload: async () => { await network.suspend(); return undefined; },
      shutdown: () => network.suspend(),
      registrations: { network },
      start: async () => {
        await network.start();
        unsubscribe = context.appPort.subscribe?.(() => network.targetChanged());
      },
      dispose,
    };
  },
  description: "Reload the app's independent host connection and settings handoff.",
  lifecycle: "handoff",
  provides: ["network"],
  requires: ["database", "logger"],
  safeAll: false,
  scope: "client:network",
  sources: [
    "app/server/runtime/AppNetworkNode.ts", "app/server/network/**",
    "shared/http/workbench-network.ts", "shared/http/workbench-service.ts",
    "shared/process/WorkbenchServiceClient.ts", "shared/process/workbench-service-endpoint.ts",
    "daemon/host/WorkbenchServiceLauncher.ts", "daemon/host/WorkbenchServiceStartup.ts",
    "daemon/host/WindowsServiceStartup.ts", "daemon/host/LinuxServiceStartup.ts",
    "shared/http/workbench-daemon-endpoint.ts", "shared/process/workbench-daemon-endpoint.ts",
  ].join("\n"),
});

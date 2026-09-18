/*
 * Default export:
 * - AppNetworkNode: own optional network configuration, sidecar lifetime and listener subscriptions below app state.
 */
import path from "node:path";
import ReloadableNode from "workbench-shared/reload/ReloadableNode";
import { WORKBENCH_DAEMON_TAILNET_PORT } from "workbench-shared/http/workbench-daemon-endpoint";
import WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import WorkbenchNetworkRepository from "../network/WorkbenchNetworkRepository.ts";
import WorkbenchLocalDaemon from "../network/WorkbenchLocalDaemon.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppHttpNode from "./AppHttpNode.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppHttpNode],
  create: (context, build) => {
    const database = build.get("database");
    const logger = build.get("logger");
    const localDaemon = new WorkbenchLocalDaemon({
      endpointPath: context.daemonEndpointPath,
      warn: message => logger.error("http", message),
    });
    const network = new WorkbenchNetworkController({
      repository: new WorkbenchNetworkRepository(database),
      root: context.repositoryRootPath,
      stateDirectory: path.join(path.dirname(database.databasePath), "network"),
      warn: message => logger.error("http", message),
      localDaemon,
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
      readTarget: configuration => {
        const app = context.appPort.current?.();
        if (!app) return null;
        const configuredPublic = process.env.WORKBENCH_CODEX_APP_SERVER_URL?.trim();
        const privateHostname = configuration.privateAccess ? `${configuration.privateAccess.label}.wb.inthedark.boo` : null;
        // A genuinely external explicit daemon retains its own TLS endpoint;
        // do not reserve its port on this installation's virtual node.
        const external = configuredPublic && (!URL.canParse(configuredPublic)
          || new URL(configuredPublic).hostname !== privateHostname);
        const daemonPort = external ? null : WORKBENCH_DAEMON_TAILNET_PORT;
        return { appOrigin: app.appOrigin, daemonOrigin: localDaemon.getSnapshot().endpoint?.origin ?? null, daemonPort };
      },
    });
    let unsubscribe: (() => void) | undefined;
    let unsubscribeDaemon: (() => void) | undefined;
    const dispose = async () => {
      unsubscribe?.();
      unsubscribeDaemon?.();
      const results = await Promise.allSettled([network.close(), localDaemon.close()]);
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
        unsubscribeDaemon = localDaemon.subscribe(() => {
          void network.targetChanged().catch(() => logger.error("http", "Daemon endpoint forwarding could not be updated."));
        });
        await localDaemon.start();
      },
      dispose,
    };
  },
  description: "Reload optional Tailscale networking, private HTTPS setup and bundled sidecar ownership.",
  lifecycle: "handoff",
  provides: ["network"],
  requires: ["database", "logger"],
  safeAll: false,
  scope: "client:network",
  sources: [
    "app/server/runtime/AppNetworkNode.ts", "app/server/network/**",
    "shared/http/workbench-network.ts", "app/network/**",
    "shared/http/workbench-daemon-endpoint.ts", "shared/process/workbench-daemon-endpoint.ts",
  ].join("\n"),
});

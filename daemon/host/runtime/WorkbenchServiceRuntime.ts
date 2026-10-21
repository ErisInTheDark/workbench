/*
 * Exports:
 * - default WorkbenchServiceRuntime: host the service dependency graph, lease ordinary requests and hold the host busy lease while reloading.
 */
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import ReloadableNodeHost from "../../../shared/reload/ReloadableNodeHost.ts";
import { createReloadableNodeModuleLoader } from "../../../shared/reload/reloadable-node-loader.ts";
import type { WorkbenchReloadScope } from "../../../shared/reload/workbench-reload.ts";
import type { ServiceProcessContext } from "./service-process-context.ts";
import type { ServiceRuntimeObjects } from "./service-runtime-objects.ts";
import WorkbenchBusyLease from "../../../shared/WorkbenchBusyLease.mjs";

export default class WorkbenchServiceRuntime {
  isReloading = false;
  private readonly host: ReloadableNodeHost<ServiceProcessContext, ServiceRuntimeObjects, never>;
  private readonly busy: WorkbenchBusyLease;

  constructor(private readonly context: ServiceProcessContext) {
    this.busy = new WorkbenchBusyLease({ dataRoot: context.dataRoot, holder: "host", warn: context.warn });
    const require = createRequire(import.meta.url);
    this.host = new ReloadableNodeHost(context, createReloadableNodeModuleLoader(
      require, "./service-root-node.ts", {
        repoRoot: context.root,
        processModule: require.cache[require.resolve("../index.ts")],
      },
    ), {
      requiredRegistrations: ["database", "network", "http", "dirt", "reload"],
      topologyScope: "host:database",
      logError: context.warn,
      onSwap: context.publish,
      processScopes: [{
        descriptor: {
          scope: "host:process", description: "Replace the independently supervised host and daemon crash unit.",
          access: "operator", destructive: true, safeAll: false,
        },
        assets: [
          "daemon/host/launch-node.mjs", "daemon/host/launch-foreground.mjs",
          "daemon/host/native/**", "daemon/host/package.json", "scripts/installation/update-journal.mjs",
        ].join("\n"),
      }],
    });
  }

  start() { return this.host.start(); }
  async close() {
    try { await this.host.dispose(); }
    finally { this.busy.close(); }
  }
  get<Key extends keyof ServiceRuntimeObjects>(key: Key) { return this.host.get(key); }
  run<Key extends keyof ServiceRuntimeObjects, Result>(key: Key, label: string, operation: (owner: ServiceRuntimeObjects[Key]) => Promise<Result>) {
    return this.host.run(key, operation, label);
  }
  handle(request: IncomingMessage, response: ServerResponse) {
    return this.host.run("http", http => http.handle(request, response), "host HTTP request");
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    return this.host.run("http", http => http.upgrade(request, socket, head), "host WebSocket upgrade");
  }
  async reload(scopes: readonly WorkbenchReloadScope[]) {
    this.host.validateReloadScopes(scopes);
    const applied = this.host.getDependantClosure(scopes);
    this.isReloading = true;
    this.busy.hold("reloading", "host reloading");
    try {
      await this.host.reload(scopes);
      await this.host.get("dirt").completeReload(applied);
    } catch (error) {
      this.host.get("dirt").failReload(error);
      throw error;
    } finally {
      this.isReloading = false;
      this.busy.hold("reloading", null);
      this.context.publish();
    }
  }
}

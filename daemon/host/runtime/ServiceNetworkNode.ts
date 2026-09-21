/*
 * Exports:
 * - default ServiceNetworkNode: own independent native networking beneath service persistence.
 */
import path from "node:path";
import ReloadableNode from "../../../shared/reload/ReloadableNode.ts";
import WorkbenchNetworkController from "../network/WorkbenchNetworkController.ts";
import WorkbenchNetworkRepository from "../network/WorkbenchNetworkRepository.ts";
import type { ServiceProcessContext } from "./service-process-context.ts";
import type { ServiceRuntimeObjects } from "./service-runtime-objects.ts";
import ServiceHttpNode from "./ServiceHttpNode.ts";

export default ReloadableNode.define<ServiceProcessContext, ServiceRuntimeObjects, never>()({
  scope: "host:network", access: "operator", lifecycle: "handoff", safeAll: false,
  description: "Reload the shared network identity, grants and discovery owner.",
  requires: ["database"], provides: ["network"], children: [ServiceHttpNode],
  sources: [
    "daemon/host/runtime/ServiceNetworkNode.ts", "daemon/host/network/**", "shared/network/**",
    "shared/http/workbench-network.ts", "shared/http/workbench-daemon-discovery.ts",
  ].join("\n"),
  create(context, build) {
    const database = build.get("database");
    const create = () => new WorkbenchNetworkController({
      repository: new WorkbenchNetworkRepository(database), root: context.root,
      stateDirectory: path.join(context.dataRoot, "app", "network"),
      target: () => ({
        appOrigin: context.sessions.current?.appOrigin ?? null,
        daemonOrigin: context.brokerOrigin(), daemonPort: 52739,
        publishDaemon: database.wakeEnabled,
        privateAppAllowed: context.sessions.current?.privateAppAllowed ?? true,
        ingressToken: context.sessions.current?.ingressToken,
        daemonIngressToken: context.ingressToken,
      }),
      preview: () => ({
        port: context.sessions.current?.previewHostPort ?? null,
        retainedPort: context.sessions.current?.retainedHostPort ?? null,
      }),
      keepPublication: context.daemonAvailable,
      warn: context.warn,
    });
    const network = create();
    const handoff = build.handoffState as { releaseCandidate?(): Promise<void> } | undefined;
    if (handoff) handoff.releaseCandidate = () => network.close();
    let unsubscribe = network.subscribe(context.publish);
    let detached = false;
    const stop = async () => { unsubscribe(); await network.close(); detached = true; };
    return {
      registrations: { network },
      start: () => network.start(),
      beginHandoff: () => {
        const transferred: { releaseCandidate?(): Promise<void> } = {};
        return {
          waitForIdle: async () => {},
          expire: () => {},
          detach: async () => { await stop(); return transferred; },
          resume: async () => {
            await transferred.releaseCandidate?.();
            unsubscribe = network.subscribe(context.publish);
            await network.start();
            detached = false;
          },
          commit: () => {},
        };
      },
      detachForReload: async () => { await stop(); return undefined; },
      dispose: async () => { if (!detached) await stop(); },
    };
  },
});

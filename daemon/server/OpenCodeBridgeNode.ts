/*
 * Exports:
 * - default OpenCodeBridgeNode: own reloadable OpenCode bridge code while preserving its app-server process.
 */
import { OpenCodeBridge, type OpenCodeBridgeState } from "./opencode-bridge";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import { logError } from "./process-helpers";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const harnesses = build.get("harnesses");
    const modules = build.get("modules");
    const bridge = new OpenCodeBridge({
      ...context.openCodeBridgeOptions,
      appServer: build.get("openCodeAppServer"),
      profiles: build.get("threadState"),
      getReloadableModules: () => modules,
      initialState: build.handoffState as OpenCodeBridgeState | undefined,
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      resolveProject: async (cwd) => {
        const { project } = await build.get("projectCatalog").resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "OpenCode identity" });
        return { projectId: project.id, projectRoot: project.rootPath };
      },
    });
    let detached = false;
    return {
      afterCommit: () => {
        bridge.start();
        void harnesses.recoverAvailable("opencode", bridge.retirementSignal).catch((error) => {
          logError("opencode-bridge", `post-reload recovery failed: ${String(error instanceof Error ? error.message : error).slice(0, 1_000)}`);
        });
      },
      beginHandoff: () => ({
        waitForIdle: () => bridge.waitForIdle(),
        expire: () => bridge.expireRuntimeDrain(),
        detach: async () => {
          const state = await bridge.detachForReload();
          detached = true;
          return state;
        },
        resume: () => {
          bridge.resumeAfterFailedReload();
          detached = false;
        },
        commit: () => bridge.stop(),
      }),
      detachForReload: async () => {
        const state = await bridge.detachForReload();
        detached = true;
        return state;
      },
      dispose: async () => {
        if (detached) return;
        await bridge.stop();
      },
      registrations: { openCodeBridge: bridge },
      start: () => undefined,
    };
  },
  description: "Reload OpenCode bridge code without restarting the OpenCode app-server.",
  lifecycle: "handoff",
  provides: ["openCodeBridge"],
  requires: ["harnesses", "modules", "openCodeAppServer", "threadIdentity", "transcriptIdentity", "projectCatalog", "threadState"],
  safeAll: true,
  scope: "server:opencode",
  sources: [
    "daemon/server/OpenCodeBridgeNode.ts",
    "daemon/server/opencode-bridge.ts",
    "daemon/server/opencode-live-thread-state.ts",
    "daemon/server/opencode-thread-state.ts",
    "daemon/server/opencode-workbench-instructions.ts",
    "daemon/server/thread-identity-provider-mapping.ts",
    "shared/workbench/thread/workbench-thread-page.ts",
  ].join("\n"),
});

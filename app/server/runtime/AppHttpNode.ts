/*
 * Default export:
 * - AppHttpNode: own reloadable app routes, static resolution, and client diagnostics.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
  access: "operator",
  children: [],
  create: (context, build) => {
    const logger = build.get("logger");
    const prediction = build.get("updatePrediction");
    const stopPrediction = prediction.follow(build.get("sources"));
    const router = new WorkbenchAppHttpRouter({
      appPort: context.appPort,
      logger,
      network: build.get("network"),
      runtime: {
        read: () => ({ ...context.readAppRuntimeSnapshot(), updateScopes: prediction.read() }),
        subscribe: listener => {
          const stopRuntime = context.subscribeAppRuntimeChanges(listener);
          const stopScopes = prediction.subscribe(listener);
          return () => { stopRuntime(); stopScopes(); };
        },
        operations: context.reloadOperations,
      },
      outputDirectoryPath: context.outputDirectoryPath,
      readAppliedReactDevelopmentMode: context.readAppliedReactDevelopmentMode,
      sourceRootPath: context.repositoryRootPath,
      state: build.get("state"),
      presentation: build.get("presentation"),
      sources: build.get("sources"),
      socketTraffic: build.get("socketTraffic"),
      workspace: build.get("workspace"),
      workspaceThreads: build.get("workspaceThreads"),
      threadPlacements: build.get("threadPlacements"),
      workspaceDrafts: build.get("workspaceDrafts"),
      gitPeers: build.get("gitPeers"),
      presentationImport: build.get("presentationImport"),
      supportsAppWebSockets: context.supportsAppWebSockets === true,
    });
    return {
      beginHandoff: () => ({
        waitForIdle: () => router.quiesceSockets(),
        expire: () => undefined,
        detach: () => undefined,
        resume: () => router.resumeSockets(),
        commit: () => { stopPrediction(); return router.close(); },
      }),
      dispose: () => { stopPrediction(); return router.close(); },
      registrations: { http: router },
      start: async () => await router.start(),
    };
  },
  description: "Reload app routes, static SPA serving, and browser diagnostic admission.",
  lifecycle: "handoff",
  provides: ["http"],
  requires: ["updatePrediction", "logger", "state", "presentation", "network", "sources", "socketTraffic", "workspace", "workspaceThreads", "threadPlacements", "workspaceDrafts", "gitPeers", "presentationImport"],
  safeAll: false,
  scope: "client:http",
});

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
    const router = new WorkbenchAppHttpRouter({
      appPort: context.appPort,
      logger,
      network: build.get("network"),
      runtime: {
        read: context.readAppRuntimeSnapshot,
        subscribe: context.subscribeAppRuntimeChanges,
      },
      outputDirectoryPath: context.outputDirectoryPath,
      readAppliedReactDevelopmentMode: context.readAppliedReactDevelopmentMode,
      state: build.get("state"),
      presentation: build.get("presentation"),
      sources: build.get("sources"),
      socketTraffic: build.get("socketTraffic"),
      workspace: build.get("workspace"),
      workspaceThreads: build.get("workspaceThreads"),
      workspaceDrafts: build.get("workspaceDrafts"),
      presentationImport: build.get("presentationImport"),
      supportsAppWebSockets: context.supportsAppWebSockets === true,
    });
    return {
      beginHandoff: () => ({
        waitForIdle: () => router.quiesceSockets(),
        expire: () => undefined,
        detach: () => undefined,
        resume: () => router.resumeSockets(),
        commit: () => router.close(),
      }),
      dispose: () => router.close(),
      registrations: { http: router },
      start: async () => await router.start(),
    };
  },
  description: "Reload app routes, static SPA serving, and browser diagnostic admission.",
  lifecycle: "handoff",
  provides: ["http"],
  requires: ["logger", "state", "presentation", "network", "sources", "socketTraffic", "workspace", "workspaceThreads", "workspaceDrafts", "presentationImport"],
  safeAll: false,
  scope: "client:http",
});

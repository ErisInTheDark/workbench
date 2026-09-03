/*
 * Default export:
 * - AppHttpNode: own reloadable app routes, static resolution, and client diagnostics. Keywords: app, HTTP, reload.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [],
  create: (context, build) => {
    const logger = build.get("logger");
    const router = new WorkbenchAppHttpRouter({
      appPort: context.appPort,
      logger,
      outputDirectoryPath: context.outputDirectoryPath,
      readAppliedReactDevelopmentMode: context.readAppliedReactDevelopmentMode,
      state: build.get("state"),
    });
    return {
      dispose: () => router.close(),
      registrations: { http: router },
      start: async () => await router.start(),
    };
  },
  description: "Reload app routes, static SPA serving, and browser diagnostic admission.",
  lifecycle: "atomic",
  provides: ["http"],
  requires: ["logger", "state"],
  safeAll: false,
  scope: "client:http",
  sources: [
    "app/runtime/AppHttpNode.ts",
    "app/runtime/WorkbenchAppHttpRouter.ts",
    "app/runtime/WorkbenchAppPortRoutes.ts",
    "app/runtime/WorkbenchAppSettingsRoutes.ts",
    "app/state/workbench-app-state-routes.ts",
    "shared/http/workbench-app-port.ts",
    "shared/http/workbench-app-settings.ts",
    "shared/http/StaticHttpRequestController.ts",
  ].join("\n"),
});

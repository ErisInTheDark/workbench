/*
 * Default export:
 * - AppHttpNode: own reloadable app routes, static resolution, and client diagnostics.
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
    "app/server/runtime/AppHttpNode.ts",
    "app/server/runtime/WorkbenchAppHttpRouter.ts",
    "app/server/runtime/WorkbenchAppPortRoutes.ts",
    "app/server/runtime/WorkbenchAppSettingsRoutes.ts",
    "app/server/state/workbench-app-state-routes.ts",
    "shared/http/workbench-app-port.ts",
    "shared/http/workbench-app-settings.ts",
    "shared/http/StaticHttpRequestController.ts",
  ].join("\n"),
});

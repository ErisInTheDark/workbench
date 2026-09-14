/*
 * Default export:
 * - AppCompilerNode: own reloadable esbuild and Tailwind watch lifecycles.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";
import type { WorkbenchFrontendGeneration } from "workbench-shared/frontend-generation";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  boundarySources: "app/client/browser-entry.tsx\napp/client/globals.css",
  children: [],
  create: (context, build) => {
    const logger = build.get("logger");
    const state = build.get("state");
    const compiler = context.createCompiler(
      logger,
      () => state.readGlobalPreference("reactDevelopmentMode") === true,
    );
    const previous = build.handoffState as { generation: WorkbenchFrontendGeneration | null } | undefined;
    if (previous) compiler.retainPublishedGeneration(previous.generation);
    const detach = async () => {
      await compiler.suspend();
      return { generation: compiler.getFrontendGeneration() };
    };
    return {
      afterCommit: () => {
        if (build.mode === "initial") return;
        void compiler.startWatching().catch((error: unknown) => {
          if (compiler.isRetirement(error)) return;
          logger.error("app", `replacement build failed; last successful frontend remains available: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
        });
      },
      beginHandoff: () => ({
        waitForIdle: () => compiler.suspend(),
        expire: () => {},
        detach,
        resume: () => compiler.resumeAfterFailedReload(),
        commit: () => compiler.close(),
      }),
      detachForReload: detach,
      dispose: () => compiler.close(),
      shutdown: () => compiler.shutdown(),
      registrations: { compiler },
      start: async () => { if (build.mode === "initial") await compiler.startWatching(); },
    };
  },
  description: "Reload esbuild and Tailwind compiler configuration and watch lifecycles.",
  lifecycle: "handoff",
  provides: ["compiler"],
  requires: ["logger", "state"],
  safeAll: false,
  scope: "client:compiler",
  sources: [
    "app/server/runtime/AppCompilerNode.ts",
    "app/server/WorkbenchFrontendCompiler.ts",
    "shared/frontend-generation.ts",
    "static/**",
  ].join("\n"),
});

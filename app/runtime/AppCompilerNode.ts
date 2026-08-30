/*
 * Default export:
 * - AppCompilerNode: own reloadable esbuild and Tailwind watch lifecycles. Keywords: app, compiler, handoff.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [],
  create: (context) => {
    const compiler = context.createCompiler();
    let detached = false;
    const close = async () => {
      await compiler.close();
      detached = true;
    };
    return {
      detachForReload: async () => {
        await close();
        return undefined;
      },
      dispose: async () => { if (!detached) await compiler.close(); },
      registrations: { compiler },
      start: async () => { await compiler.startWatching(); },
    };
  },
  description: "Reload esbuild and Tailwind compiler configuration and watch lifecycles.",
  lifecycle: "handoff",
  provides: ["compiler"],
  requires: [],
  safeAll: false,
  scope: "client:compiler",
  sources: [
    "app/runtime/AppCompilerNode.ts",
    "app/WorkbenchFrontendCompiler.ts",
    "app/workbench-library-root.ts",
  ].join("\n"),
});

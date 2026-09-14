/*
 * Default export:
 * - AppTopologyNode: mark app graph declaration ownership and topology reload selection.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [],
  create: () => ({
    dispose: () => {},
    registrations: { topology: Object.freeze({}) },
    start: () => {},
  }),
  description: "Reload app graph declarations and validate topology changes.",
  lifecycle: "atomic",
  provides: ["topology"],
  requires: [],
  safeAll: false,
  scope: "client:topology",
  sources: "app/server/runtime/*Node.ts\napp/server/runtime/app-root-node.ts\napp/server/runtime/app-runtime-objects.ts\napp/server/runtime/app-process-context.ts",
});

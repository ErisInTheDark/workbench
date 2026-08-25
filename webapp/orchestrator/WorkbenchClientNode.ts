/*
 * Exports:
 * - default WorkbenchClientNode: own the Next client development-server reload action. Keywords: client, next, reload.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => ({
    detachForReload: () => undefined,
    dispose: () => undefined,
    registrations: {},
    start: async () => { if (build.mode === "replacement") await context.reloadClient(); },
  }),
  description: "Restart the Next client development server.",
  lifecycle: "handoff",
  provides: [],
  requires: [],
  safeAll: true,
  scope: "client:all",
  sources: [
    "webapp/app/**",
    "webapp/components/**",
    "webapp/hooks/**",
    "webapp/lib/**",
    "!webapp/lib/workbench/instructions/**/*.md",
  ].join("\n"),
});

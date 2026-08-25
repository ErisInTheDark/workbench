/*
 * Exports:
 * - default WorkbenchInstructionsNode: acknowledge auto-fresh Workbench instruction Markdown without replacing runtime state. Keywords: instructions, reload, no-op.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: () => ({
    dispose: () => undefined,
    registrations: {},
    start: () => undefined,
  }),
  description: "Acknowledge auto-fresh Workbench instruction Markdown without replacing runtime state.",
  lifecycle: "atomic",
  provides: [],
  requires: [],
  safeAll: false,
  scope: "server:instructions",
  sources: "webapp/lib/workbench/instructions/**/*.md",
});

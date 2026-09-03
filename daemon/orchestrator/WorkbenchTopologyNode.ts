/*
 * Exports:
 * - default WorkbenchTopologyNode: mark graph-definition ownership above its MCP dependant. Keywords: topology, graph, reload.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: () => ({ dispose: () => undefined, registrations: {}, start: () => undefined }),
  description: "Reload graph definitions and their direct MCP dependant.",
  lifecycle: "atomic",
  provides: [],
  requires: [],
  safeAll: true,
  scope: "server:topology",
  sources: "",
});

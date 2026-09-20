/*
 * Exports:
 * - default WorkbenchTopologyNode: mark graph-definition ownership above its MCP dependant.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
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

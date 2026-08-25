/*
 * Exports:
 * - default WorkbenchTopologyNode: own reload admission, queue handoff, and direct topology child declarations. Keywords: topology, reload, queue.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchOrchestratorReloadController, { type WorkbenchOrchestratorReloadControllerState } from "./WorkbenchOrchestratorReloadController";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: (context, build) => {
    const controller = new WorkbenchOrchestratorReloadController({
      executeBatch: context.executeReloadScopes,
      getReloadScopeCatalog: context.getReloadScopeCatalog,
      hardReload: context.hardReload,
      initialState: build.handoffState as WorkbenchOrchestratorReloadControllerState | undefined,
      listClaims: async (cwd) => await build.get("gitArc").listReloadScopeClaims(cwd),
      listScopes: () => context.getReloadScopeCatalog().map(({ scope }) => scope),
    });
    let detached = false;
    return {
      detachForReload: () => {
        detached = true;
        return controller.detachForReload();
      },
      dispose: () => { if (!detached) controller.dispose(); },
      registrations: { reloadController: controller },
      start: () => undefined,
    };
  },
  description: "Reload graph definitions and the lifecycle-owned reload queue.",
  lifecycle: "handoff",
  provides: ["reloadController"],
  requires: ["gitArc"],
  safeAll: false,
  scope: "server:topology",
  sources: [
    "webapp/orchestrator/*Node.ts",
    "webapp/orchestrator/ReloadableNode.ts",
    "webapp/orchestrator/WorkbenchOrchestratorReloadController.ts",
    "webapp/orchestrator/orchestrator-root-node.ts",
    "webapp/orchestrator/orchestrator-runtime-objects.ts",
    "webapp/lib/workbench/orchestrator-reload.ts",
  ].join("\n"),
});

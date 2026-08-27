/*
 * Exports:
 * - default WorkbenchAgentCommandNode: own shared wb CLI and MCP command execution below core and above MCP adaptation. Keywords: agent command, CLI, MCP, reload graph.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchMcpNode from "./WorkbenchMcpNode";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: (context, build) => {
    const gitArc = build.get("gitArc");
    const harnesses = build.get("harnesses");
    const subagents = build.get("subagents");
    const threadState = build.get("threadState");
    const reloadDirt = build.get("reloadDirt");
    const agentCommand = new WorkbenchAgentCommandController(context.localWorkbenchOrigin, context.localOrchestratorOrigin, {
      checkApplyPatchClaims: async ({ cwd, harness, paths, threadId }) => await gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths),
      executeBrowseRequest: context.executeBrowseRequest,
      executeGitArcRequest: async (body, signal) => await gitArc.executeRequest(body, signal),
      executeSessionRequest: context.executeBrowseSessionRequest,
      getReloadDirt: async (signal) => await reloadDirt.refresh(signal),
      getReloadScopeCatalog: () => reloadDirt.getCatalog(),
      requestCodex: async (request) => await harnesses.request("codex", request),
      requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
        ? await threadState.handleManagedThreadRequest(request)
        : await subagents.handleRequest(request),
    });
    return {
      beginRuntimeDrain: () => { agentCommand.beginRuntimeDrain(); },
      dispose: async () => { await agentCommand.dispose(); },
      listRuntimeDrainPending: () => agentCommand.listRuntimeDrainPending(),
      registrations: { agentCommand },
      start: () => undefined,
    };
  },
  description: "Reload shared wb CLI and MCP command execution without replacing core state.",
  lifecycle: "atomic",
  provides: ["agentCommand"],
  requires: ["gitArc", "harnesses", "reloadDirt", "subagents", "threadState"],
  safeAll: true,
  scope: "server:commands",
  sources: [
    "webapp/orchestrator/WorkbenchAgentCommandNode.ts",
    "webapp/orchestrator/WorkbenchAgentCommandController*.ts",
    "webapp/orchestrator/CodexCommandExecController*.ts",
    "webapp/orchestrator/WorkbenchRipgrepController*.ts",
    "webapp/lib/workbench/commands/**",
    "webapp/lib/workbench/cli/**",
  ].join("\n"),
});

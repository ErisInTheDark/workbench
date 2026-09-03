/*
 * Exports:
 * - default WorkbenchMcpNode: own the wb MCP server and HTTP router after core and topology parents are active. Keywords: mcp, router, graph.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import WorkbenchOrchestratorHttpRouter from "./WorkbenchOrchestratorHttpRouter";
import WorkbenchTranscriptAssetController from "./WorkbenchTranscriptAssetController";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

const REQUIRED_REGISTRATIONS = [
  "agentCommand",
  "bridgeRequest",
  "codexMcpGeneration",
  "gitArc",
  "harnesses",
  "legacyMigrationSource",
  "projectCatalog",
  "projectSnapshot",
  "reloadController",
  "threadGit",
  "threadState",
] as const satisfies readonly (keyof OrchestratorRuntimeObjects)[];

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const agentCommand = build.get("agentCommand");
    const harnesses = build.get("harnesses");
    const codexMcpGeneration = build.get("codexMcpGeneration");
    const threadState = build.get("threadState");
    build.get("reloadController");
    const stopWaitObservation = getProcessWorkbenchAgentMcpRequestRegistry().subscribeThreadWaits(({ threadId, toolNames }) => {
      threadState.controller.setThreadWaitState("codex", threadId, toolNames);
    });
    const mcp = new WorkbenchAgentMcpController({
      executeCommand: async (request, signal) => await agentCommand.executeStructuredRequest(request, signal),
      getReloadScopeCatalog: context.getReloadScopeCatalog,
      orchestratorOrigin: context.localOrchestratorOrigin,
      requestCodex: async (request) => await harnesses.request("codex", request),
      runLoggedCommand: async (label, signal, operation, succeeded) => (
        await agentCommand.runLoggedCommand(label, signal, operation, succeeded)
      ),
    });
    const orchestratorHttp = new WorkbenchOrchestratorHttpRouter({
      agentCommand,
      bridgeRequest: build.get("bridgeRequest"),
      gitArc: build.get("gitArc"),
      legacyMigrationSource: build.get("legacyMigrationSource"),
      mcp,
      projectCatalog: build.get("projectCatalog"),
      projectSnapshot: build.get("projectSnapshot"),
      threadGit: build.get("threadGit"),
      transcriptAssets: new WorkbenchTranscriptAssetController(context.legacyMigrationProjectRoot),
    });
    return {
      activate: () => {
        if (build.mode === "replacement") codexMcpGeneration.bump();
      },
      beginRuntimeDrain: () => { mcp.beginRuntimeDrain(); },
      dispose: () => {
        stopWaitObservation();
        mcp.releaseRuntimeOwner();
      },
      expireRuntimeDrain: () => { mcp.expireRuntimeDrain(); },
      listRuntimeDrainPending: () => mcp.listRuntimeDrainPending().map(({ ageMs, policy, toolName }) => ({
        ageMs,
        label: `mcp ${toolName}${policy ? ` [${policy}]` : ""}`,
      })),
      registrations: { mcp, orchestratorHttp },
      start: async () => {
        if (build.mode === "replacement") await context.refreshWorkbenchPromptFiles();
      },
    };
  },
  description: "Reload the wb MCP server and orchestrator HTTP router.",
  lifecycle: "atomic",
  provides: ["mcp", "orchestratorHttp"],
  requires: REQUIRED_REGISTRATIONS,
  safeAll: true,
  scope: "server:mcp",
  sources: [
    "daemon/orchestrator/WorkbenchMcpNode.ts",
    "daemon/orchestrator/WorkbenchAgentMcpController.ts",
    "daemon/orchestrator/WorkbenchOrchestratorHttpRouter.ts",
    "daemon/orchestrator/WorkbenchShellController*.ts",
    "shared/workbench/commands/workbench-shell-command.ts",
    "daemon/orchestrator/workbench-agent-mcp-request-registry.ts",
  ].join("\n"),
});

/*
 * Exports:
 * - default WorkbenchAgentCommandNode: own shared wb CLI and MCP command execution below core and above MCP adaptation. Keywords: agent command, CLI, MCP, reload graph.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import type { WorkbenchThreadContextReadResponse } from "../lib/types";
import WorkbenchThreadRecallController, {
  toWorkbenchThreadRecallBundle,
} from "../lib/workbench/thread/WorkbenchThreadRecallController";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentCommandController from "./WorkbenchAgentCommandController";
import WorkbenchAgentCommandLogger from "./WorkbenchAgentCommandLogger";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchTokenCountController from "./WorkbenchTokenCountController";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchMcpNode],
  create: (context, build) => {
    const gitArc = build.get("gitArc");
    const harnesses = build.get("harnesses");
    const subagents = build.get("subagents");
    const threadState = build.get("threadState");
    const reloadDirt = build.get("reloadDirt");
    const tokens = new WorkbenchTokenCountController({ projectRoot: context.legacyMigrationProjectRoot });
    const commandLogger = new WorkbenchAgentCommandLogger();
    const threadRecall = new WorkbenchThreadRecallController({
      readBundle: async (threadId, signal) => {
        signal.throwIfAborted();
        const response = await harnesses.request("codex", {
          id: 0,
          method: "thread/context/read",
          params: { includeTurns: true, threadId, workbenchReadScope: "threadRecall" },
          workbenchThreadHydration: { mode: "legacyFull" },
        });
        signal.throwIfAborted();
        if (response.error) throw new Error(response.error.message);
        return toWorkbenchThreadRecallBundle(response.result as WorkbenchThreadContextReadResponse);
      },
    });
    const agentCommand = new WorkbenchAgentCommandController(context.localOrchestratorOrigin, {
      checkApplyPatchClaims: async ({ cwd, harness, paths, threadId }) => await gitArc.checkActiveClaimPaths(cwd, harness, threadId, paths),
      executeBrowseRequest: context.executeBrowseRequest,
      executeGitArcRequest: async (body, signal) => await gitArc.executeRequest(body, signal),
      executeThreadGitRequest: async (body, signal) => {
        signal.throwIfAborted();
        return await build.get("threadGit").executeRequest(body);
      },
      executeThreadRecallRequest: async (request, signal) => {
        const url = new URL(request.path, context.localOrchestratorOrigin);
        const prefix = "/api/thread-context/";
        if (!url.pathname.startsWith(prefix)) throw new Error("Invalid Thread Recall command path.");
        return await threadRecall.execute({
          body: request.body,
          method: request.method,
          searchParams: url.searchParams,
          threadId: decodeURIComponent(url.pathname.slice(prefix.length)),
        }, signal);
      },
      executeTokenCount: async (body, signal) => await tokens.execute(body, signal),
      executeSessionRequest: context.executeBrowseSessionRequest,
      getReloadDirt: async (signal) => await reloadDirt.refresh(signal),
      getReloadScopeCatalog: () => reloadDirt.getCatalog(),
      requestCodex: async (request) => await harnesses.request("codex", request),
      requestSubagent: async (request) => request.method?.startsWith("workbench/thread/")
        ? await threadState.handleManagedThreadRequest(request)
        : await subagents.handleRequest(request),
      workbenchProjectRoot: context.legacyMigrationProjectRoot,
    }, undefined, undefined, commandLogger);
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
  requires: ["gitArc", "harnesses", "reloadDirt", "subagents", "threadGit", "threadState"],
  safeAll: true,
  scope: "server:commands",
  sources: [
    "webapp/orchestrator/WorkbenchAgentCommandNode.ts",
    "webapp/orchestrator/WorkbenchAgentCommandController*.ts",
    "webapp/orchestrator/WorkbenchAgentCommandLogger*.ts",
    "webapp/orchestrator/CodexCommandExecController*.ts",
    "webapp/orchestrator/WorkbenchRipgrepController*.ts",
    "webapp/orchestrator/WorkbenchTokenCountController*.ts",
    "webapp/lib/workbench/commands/**",
    "webapp/lib/workbench/cli/**",
    "webapp/lib/workbench/thread/WorkbenchThreadRecallController.ts",
  ].join("\n"),
});

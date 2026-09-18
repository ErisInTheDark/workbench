/*
 * Exports:
 * - default WorkbenchMcpNode: own the wb MCP server and HTTP router after core and topology parents are active.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import WorkbenchDaemonHttpRouter from "./WorkbenchDaemonHttpRouter";
import WorkbenchTranscriptAssetController from "./WorkbenchTranscriptAssetController";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";
import WorkbenchProviderDispatcher from "./WorkbenchProviderDispatcher";
import { installedProviderKeys } from "workbench-shared/workbench/provider/provider-registrations";

const REQUIRED_REGISTRATIONS = [
  "agentCommand",
  "toolRevision",
  "database",
  "gitArc",
  "harnesses",
  "projectCatalog",
  "projectSnapshot",
  "reloadController",
  "threadGit",
  "threadIdentity",
  "threadState",
] as const satisfies readonly (keyof DaemonRuntimeObjects)[];

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const agentCommand = build.get("agentCommand");
    const providers = new WorkbenchProviderDispatcher(build.run);
    const toolRevision = build.get("toolRevision");
    const threadIdentity = build.get("threadIdentity");
    const threadState = build.get("threadState");
    build.get("reloadController");
    const requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry();
    const commandExecutorOwner = {};
    let commandExecutorActive = false;
    const activateCommandExecutor = () => {
      if (commandExecutorActive) return;
      requestRegistry.activateCommandExecutor(
        commandExecutorOwner,
        async (request, signal) => await agentCommand.executeStructuredRequest(request, signal),
      );
      commandExecutorActive = true;
    };
    let stopWaitObservation: (() => void) | null = null;
    const mcp = new WorkbenchAgentMcpController({
      tools: selector => {
        const key = installedProviderKeys.find(key => key === selector);
        if (!key) throw new Error(`Provider ${selector} is not installed.`);
        const tools = providers.get(key).tools;
        if (!tools) throw new Error(`Provider ${selector} does not support managed tools.`);
        return tools;
      },
      executeCommand: async (request, signal) => await requestRegistry.executeCommand(request, signal),
      getReloadScopeCatalog: context.getReloadScopeCatalog,
      daemonOrigin: context.localDaemonOrigin,
      requestRegistry,
      runLoggedCommand: async (label, signal, operation, succeeded) => (
        await agentCommand.runLoggedCommand(label, signal, operation, succeeded)
      ),
    });
    const daemonHttp = new WorkbenchDaemonHttpRouter({
      agentCommand,
      gitArc: build.get("gitArc"),
      mcp,
      projectCatalog: build.get("projectCatalog"),
      projectSnapshot: build.get("projectSnapshot"),
      threadGit: build.get("threadGit"),
      transcriptAssets: new WorkbenchTranscriptAssetController(build.get("database")),
    });
    return {
      afterCommit: () => {
        activateCommandExecutor();
        stopWaitObservation ??= requestRegistry.subscribeThreadWaits(
          ({ threadId, toolNames }) => {
            for (const binding of threadIdentity.knownThread(threadId).bindings) {
              threadState.controller.setThreadWaitState(binding.harness, threadId, toolNames);
            }
          },
          nativeThreadId => {
            const binding = installedProviderKeys
              .map(key => threadIdentity.findNativeBinding(key, nativeThreadId))
              .find(binding => binding !== undefined);
            if (!binding) throw new Error("A retained MCP wait has no admitted provider binding.");
            return threadIdentity.workbenchIdForNative(binding);
          },
        );
        if (build.mode === "replacement") toolRevision.bump();
      },
      beginRuntimeDrain: () => { mcp.beginRuntimeDrain(); },
      dispose: () => {
        requestRegistry.releaseCommandExecutor(commandExecutorOwner);
        stopWaitObservation?.();
        stopWaitObservation = null;
        mcp.releaseRuntimeOwner();
      },
      expireRuntimeDrain: () => { mcp.expireRuntimeDrain(); },
      listRuntimeDrainPending: () => mcp.listRuntimeDrainPending().map(({ ageMs, policy, toolName }) => ({
        ageMs,
        label: `mcp ${toolName}${policy ? ` [${policy}]` : ""}`,
      })),
      registrations: { mcp, daemonHttp },
      start: async () => {
        if (build.mode === "replacement") await context.refreshWorkbenchPromptFiles();
      },
    };
  },
  description: "Reload the wb MCP server and daemon HTTP router.",
  lifecycle: "atomic",
  provides: ["mcp", "daemonHttp"],
  requires: REQUIRED_REGISTRATIONS,
  safeAll: true,
  scope: "server:mcp",
  sources: [
    "daemon/server/WorkbenchMcpNode.ts",
    "daemon/server/WorkbenchAgentMcpController.ts",
    "daemon/server/WorkbenchDaemonHttpRouter.ts",
    "daemon/server/WorkbenchTranscriptAssetController.ts",
    "shared/workbench/commands/workbench-shell-command.ts",
    "shared/http/loopback-connection.ts",
    "daemon/server/workbench-agent-mcp-request-registry.ts",
  ].join("\n"),
});

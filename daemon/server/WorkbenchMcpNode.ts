/*
 * Exports:
 * - default WorkbenchMcpNode: own the wb MCP server and HTTP router after core and topology parents are active.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import WorkbenchAgentMcpController from "./WorkbenchAgentMcpController";
import WorkbenchDaemonHttpRouter from "./WorkbenchDaemonHttpRouter";
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
  "threadIdentity",
  "threadState",
] as const satisfies readonly (keyof DaemonRuntimeObjects)[];

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (context, build) => {
    const agentCommand = build.get("agentCommand");
    const harnesses = build.get("harnesses");
    const codexMcpGeneration = build.get("codexMcpGeneration");
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
      resolveThreadId: async (threadId, cwd) => {
        const project = await build.get("projectCatalog").resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench MCP" });
        const identity = await threadIdentity.resolve({ threadId: ThreadReferenceSchema.parse(threadId), projectId: project.project.id, harness: "codex" });
        if (!identity) throw new Error("The managed Codex thread has no Workbench identity.");
        return identity.threadId;
      },
      executeCommand: async (request, signal) => await requestRegistry.executeCommand(request, signal),
      getReloadScopeCatalog: context.getReloadScopeCatalog,
      daemonOrigin: context.localDaemonOrigin,
      requestRegistry,
      requestCodex: async (request) => await harnesses.request("codex", request),
      runLoggedCommand: async (label, signal, operation, succeeded) => (
        await agentCommand.runLoggedCommand(label, signal, operation, succeeded)
      ),
    });
    const daemonHttp = new WorkbenchDaemonHttpRouter({
      agentCommand,
      bridgeRequest: build.get("bridgeRequest"),
      gitArc: build.get("gitArc"),
      legacyMigrationSource: build.get("legacyMigrationSource"),
      mcp,
      projectCatalog: build.get("projectCatalog"),
      projectSnapshot: build.get("projectSnapshot"),
      threadGit: build.get("threadGit"),
      transcriptAssets: new WorkbenchTranscriptAssetController(context.legacyMigrationProjectRoot, build.get("threadIdentity")),
    });
    return {
      afterCommit: () => {
        activateCommandExecutor();
        stopWaitObservation ??= requestRegistry.subscribeThreadWaits(
          ({ threadId, toolNames }) => {
            threadState.controller.setThreadWaitState("codex", threadId, toolNames);
          },
          nativeThreadId => threadIdentity.workbenchIdForNative(
            threadIdentity.knownNativeBinding("codex", nativeThreadId),
          ),
        );
        if (build.mode === "replacement") codexMcpGeneration.bump();
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
    "daemon/server/WorkbenchShellController*.ts",
    "shared/workbench/commands/workbench-shell-command.ts",
    "daemon/server/workbench-agent-mcp-request-registry.ts",
  ].join("\n"),
});

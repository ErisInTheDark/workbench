/*
 * Exports:
 * - recoverCodexSqliteTranscriptBeforeAvailability: settle marked recovery and active provider baselines before reopening Codex. Keywords: codex, transcript, recovery, baseline.
 * - default CodexBridgeNode: own reloadable Codex bridge code and questionnaire routing while preserving the parent app-server process. Keywords: codex, bridge, questionnaire, handoff.
 */
import CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import { applyServerCodexSandboxPolicy } from "./codex-sandbox-policy";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function recoverCodexSqliteTranscriptBeforeAvailability(
  bridge: Pick<CodexStdioBridge, "recoverSqliteTranscriptThread">,
  transcript: Pick<OrchestratorRuntimeObjects["transcript"], "cutoverFailure" | "pendingRecoveryThreadIds">,
  reportFailure: (threadId: string | null, error: unknown) => void,
  recoverAvailable: () => Promise<void>,
  activeBaseline?: {
    captureGap(threadId: string, error: unknown): Promise<Error>;
    readThread(threadId: string): Promise<void>;
    threadIds: readonly string[];
  },
) {
  let reportedRecoveryFailure = false;
  const recoveryThreadIds = [...transcript.pendingRecoveryThreadIds];
  const attemptedThreadIds = new Set(recoveryThreadIds);
  for (const threadId of recoveryThreadIds) {
    try {
      await bridge.recoverSqliteTranscriptThread(threadId);
      if (transcript.pendingRecoveryThreadIds.includes(threadId)) {
        throw new Error(`SQLite transcript recovery did not settle thread ${threadId}.`);
      }
    } catch (error) {
      reportedRecoveryFailure = true;
      reportFailure(threadId, error);
    }
  }
  for (const threadId of new Set(activeBaseline?.threadIds ?? [])) {
    if (attemptedThreadIds.has(threadId)) continue;
    try {
      await activeBaseline!.readThread(threadId);
    } catch (error) {
      reportedRecoveryFailure = true;
      try {
        reportFailure(threadId, await activeBaseline!.captureGap(threadId, error));
      } catch (captureError) {
        reportFailure(
          threadId,
          new AggregateError([error, captureError], `SQLite transcript baseline and gap capture failed for ${threadId}.`),
        );
      }
    }
  }
  if (!reportedRecoveryFailure && transcript.cutoverFailure) {
    reportFailure(null, transcript.cutoverFailure);
  }
  await recoverAvailable();
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  boundarySources: [
    "daemon/orchestrator/CodexTranscriptStore.ts",
    "daemon/orchestrator/codex-transcript-*.ts",
  ].join("\n"),
  children: [],
  create: (context, build) => {
    const parent = build.get("codexAppServer");
    const codexMcpGeneration = build.get("codexMcpGeneration");
    const codexSandboxNetwork = build.get("codexSandboxNetwork");
    const codexInstructions = build.get("codexInstructions");
    const harnesses = build.get("harnesses");
    const projectCatalog = build.get("projectCatalog");
    const questionnaires = build.get("questionnaires");
    const transcript = build.get("transcript");
    const threadState = build.get("threadState");
    const turnRecovery = build.get("turnRecovery");
    let bridge!: CodexStdioBridge;
    const prepareTurnStart = async (
      request: JsonRpcRequest,
      requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
    ) => {
      const threadId = typeof record(request.params)?.threadId === "string" ? String(record(request.params)!.threadId).trim() : "";
      if (!threadId) throw new Error("Codex turn/start requires a thread id before MCP freshness can be checked.");
      const state = await threadState.getCodexMcpState(threadId, requestProvider);
      const [project, networkAccess] = await Promise.all([
        projectCatalog.resolveProjectById(state.projectId),
        codexSandboxNetwork.resolve(state.projectId),
      ]);
      const generation = await codexMcpGeneration.prepare(state.generation, async () => {
        const response = await requestProvider({
          id: `workbench:mcp-refresh:${codexMcpGeneration.generation}`,
          method: "config/mcpServer/reload",
          params: null,
        });
        if (response.error) throw new Error(response.error.message);
      });
      await threadState.setManagedCodexMcpGeneration(state.projectId, threadId, generation);
      applyServerCodexSandboxPolicy(
        request,
        project.roots.map((root) => root.rootPath),
        networkAccess,
      );
    };
    bridge = new CodexStdioBridge({
      ...context.createCodexBridgeOptions(parent.appServer, build.handoffState as CodexStdioBridgeReloadState | undefined),
      instructions: codexInstructions,
      prepareThreadConfiguration: async (thread, requests) => {
        const profile = await threadState.prepareCodexProfile(thread);
        const project = await projectCatalog.resolveProjectById(profile.projectId);
        const configuration = {
          cwd: profile.cwd, projectId: profile.projectId,
          roots: project.roots.map((root, index) => ({
            id: root.id, isPrimary: index === 0, name: root.name,
            relativePath: root.relativePath ?? ".", rootPath: root.rootPath,
          })),
          settings: profile.selection.settings, subagentName: profile.subagentName, threadId: thread.id,
        };
        const resumeRequest = codexInstructions.withThreadConfiguration(requests.resumeRequest, configuration);
        const startRequest = codexInstructions.withThreadConfiguration(requests.startRequest, configuration);
        turnRecovery.observeRequest("codex", resumeRequest);
        turnRecovery.observeRequest("codex", startRequest);
        return { resumeRequest, startRequest };
      },
      prepareTurnStart,
      questionnaires,
      readSqliteTranscriptMaterializedTurnIds: (threadId, turnIds) => (
        transcript.readMaterializedTurnIds(threadId, turnIds)
      ),
      recordSqliteTranscript: async (observations, recordingContext) => {
        await transcript.record(observations, recordingContext);
      },
      restartingAppServer: build.isReplacing("harness:codex"),
      transcriptShadowLog: build.get("transcriptShadowLog"),
    });
    parent.attachBridge(bridge);
    let activated = build.mode === "initial";
    let detached = false;
    return {
      activate: async () => {
        if (build.mode === "replacement") codexMcpGeneration.bump();
        activated = true;
        await recoverCodexSqliteTranscriptBeforeAvailability(
          bridge,
          transcript,
          (threadId, error) => {
            const message = error instanceof Error ? error.message : String(error);
            build.get("transcriptShadowLog").write({
              event: "capture-recovery-failed",
              fields: {
                ...(threadId ? { threadId } : {}),
                message: message.slice(0, 500),
              },
              level: "error",
              source: "codex-transcript",
            });
          },
          () => harnesses.recoverAvailable("codex"),
          build.isReplacing("server:database")
            ? {
                captureGap: (threadId, error) => transcript.captureProviderGap(threadId, error),
                readThread: (threadId) => bridge.baselineSqliteTranscriptThread(threadId),
                threadIds: bridge.activeSqliteTranscriptThreadIds,
              }
            : undefined,
        );
      },
      detachForReload: async (replacement) => {
        const restartingAppServer = replacement.isReplacing("harness:codex");
        if (restartingAppServer) turnRecovery.captureForReload(["codex"]);
        context.onCodexBridgeUnavailable(restartingAppServer);
        const state = await parent.detachBridge(bridge, { restartingAppServer });
        detached = true;
        return state;
      },
      dispose: async () => {
        if (detached) return;
        if (activated) await bridge.dispose();
        else await bridge.detachForReload();
      },
      registrations: { codexBridge: bridge },
      start: async () => {
        if (build.mode !== "initial") {
          await context.onCodexBridgeReady(bridge);
        }
        build.get("codexHealth").start({ armed: true });
      },
    };
  },
  description: "Reload Codex bridge code without restarting the Codex app-server.",
  lifecycle: "handoff",
  provides: ["codexBridge"],
  requires: ["codexAppServer", "codexHealth", "codexInstructions", "codexMcpGeneration", "codexSandboxNetwork", "harnesses", "projectCatalog", "questionnaires", "threadState", "transcript", "transcriptShadowLog", "turnRecovery"],
  safeAll: true,
  scope: "server:codex",
  sources: [
    "daemon/orchestrator/CodexBridgeNode.ts",
    "daemon/orchestrator/codex-sandbox-policy.ts",
    "daemon/orchestrator/CodexStdioBridge.ts",
    "daemon/orchestrator/CodexThreadWindowLoader.ts",
    "shared/workbench/thread/workbench-thread-page.ts",
    "daemon/orchestrator/workbench-agent-mcp-request-registry.ts",
    "daemon/orchestrator/CodexBridgeTransitionController.ts",
    "daemon/orchestrator/CodexRecoverySupervisor.ts",
    "daemon/orchestrator/CodexTranscriptRecordingController.ts",
    "daemon/orchestrator/copilot-bridge.ts",
    "daemon/orchestrator/copilot-thread-state.ts",
  ].join("\n"),
});

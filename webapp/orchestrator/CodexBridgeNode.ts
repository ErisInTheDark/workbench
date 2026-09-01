/*
 * Exports:
 * - recoverCodexAfterSqliteTranscriptCaptureGap: attempt marked provider recovery without blocking later harness availability. Keywords: codex, transcript, recovery.
 * - default CodexBridgeNode: own reloadable Codex bridge code while preserving the parent app-server process. Keywords: codex, bridge, handoff.
 */
import CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function recoverCodexAfterSqliteTranscriptCaptureGap(
  bridge: Pick<CodexStdioBridge, "recoverSqliteTranscriptThread">,
  transcript: Pick<OrchestratorRuntimeObjects["transcript"], "cutoverFailure" | "pendingRecoveryThreadIds">,
  reportFailure: (threadId: string | null, error: unknown) => void,
  recoverAvailable: () => Promise<void>,
) {
  let reportedRecoveryFailure = false;
  for (const threadId of transcript.pendingRecoveryThreadIds) {
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
  if (!reportedRecoveryFailure && transcript.cutoverFailure) {
    reportFailure(null, transcript.cutoverFailure);
  }
  await recoverAvailable();
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  boundarySources: [
    "webapp/orchestrator/CodexTranscriptStore.ts",
    "webapp/orchestrator/codex-transcript-*.ts",
  ].join("\n"),
  children: [],
  create: (context, build) => {
    const parent = build.get("codexAppServer");
    const codexMcpGeneration = build.get("codexMcpGeneration");
    const codexInstructions = build.get("codexInstructions");
    const harnesses = build.get("harnesses");
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
      const generation = await codexMcpGeneration.prepare(state.generation, async () => {
        const response = await requestProvider({
          id: `workbench:mcp-refresh:${codexMcpGeneration.generation}`,
          method: "config/mcpServer/reload",
          params: null,
        });
        if (response.error) throw new Error(response.error.message);
      });
      await threadState.setManagedCodexMcpGeneration(state.projectId, threadId, generation);
    };
    bridge = new CodexStdioBridge({
      ...context.createCodexBridgeOptions(parent.appServer, build.handoffState as CodexStdioBridgeReloadState | undefined),
      instructions: codexInstructions,
      prepareTurnStart,
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
        await recoverCodexAfterSqliteTranscriptCaptureGap(
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
  requires: ["codexAppServer", "codexHealth", "codexInstructions", "codexMcpGeneration", "harnesses", "threadState", "transcript", "transcriptShadowLog", "turnRecovery"],
  safeAll: true,
  scope: "server:codex",
  sources: [
    "webapp/orchestrator/CodexBridgeNode.ts",
    "webapp/orchestrator/CodexStdioBridge.ts",
    "webapp/orchestrator/CodexThreadWindowLoader.ts",
    "webapp/lib/workbench/thread/workbench-thread-page.ts",
    "webapp/orchestrator/workbench-agent-mcp-request-registry.ts",
    "webapp/orchestrator/CodexBridgeTransitionController.ts",
    "webapp/orchestrator/CodexRecoverySupervisor.ts",
    "webapp/orchestrator/CodexTranscriptRecordingController.ts",
    "webapp/orchestrator/copilot-bridge.ts",
    "webapp/orchestrator/copilot-thread-state.ts",
  ].join("\n"),
});

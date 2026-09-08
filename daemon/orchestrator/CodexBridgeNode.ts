/*
 * Keywords: Codex bridge, patch controller, reload handoff, transcript readiness.
 * Exports:
 * - recoverCodexSqliteTranscripts: repair marked recovery and active baselines independently of harness availability.
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

export async function recoverCodexSqliteTranscripts(
  bridge: Pick<CodexStdioBridge, "recoverSqliteTranscriptThread">,
  transcript: Pick<OrchestratorRuntimeObjects["transcript"], "cutoverFailure" | "pendingRecoveryThreadIds">,
  reportFailure: (threadId: string | null, error: unknown) => void,
  recoverAvailable: () => Promise<void>,
  activeBaseline?: {
    captureGap(threadId: string, error: unknown): Promise<Error>;
    readThread(threadId: string, signal?: AbortSignal): Promise<void>;
    threadIds: readonly string[];
  },
  signal?: AbortSignal,
) {
  await recoverAvailable();
  let reportedRecoveryFailure = false;
  const recoveryThreadIds = [...transcript.pendingRecoveryThreadIds];
  const attemptedThreadIds = new Set(recoveryThreadIds);
  for (const threadId of recoveryThreadIds) {
    if (signal?.aborted) return;
    try {
      await bridge.recoverSqliteTranscriptThread(threadId, signal);
      if (signal?.aborted) return;
      if (transcript.pendingRecoveryThreadIds.includes(threadId)) {
        throw new Error(`SQLite transcript recovery did not settle thread ${threadId}.`);
      }
    } catch (error) {
      if (signal?.aborted) return;
      reportedRecoveryFailure = true;
      reportFailure(threadId, error);
    }
  }
  for (const threadId of new Set(activeBaseline?.threadIds ?? [])) {
    if (signal?.aborted) return;
    if (attemptedThreadIds.has(threadId)) continue;
    try {
      await activeBaseline!.readThread(threadId, signal);
    } catch (error) {
      if (signal?.aborted) return;
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
    let recovery: { controller: AbortController; completion: Promise<void> } | null = null;
    const reportRecoveryFailure = (threadId: string | null, error: unknown) => {
      build.get("transcriptShadowLog").write({
        event: "capture-recovery-failed",
        fields: {
          ...(threadId ? { threadId } : {}),
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
        level: "error", source: "codex-transcript",
      });
    };
    const startRecovery = () => {
      if (recovery) return;
      const controller = new AbortController();
      const completion = (async () => {
        await recoverCodexSqliteTranscripts(
          bridge, transcript, reportRecoveryFailure,
          // Process startup already owns persisted turn recovery. Replacement has no such callback.
          build.mode === "initial" ? async () => undefined : () => harnesses.recoverAvailable("codex"),
          build.isReplacing("server:database") ? {
            captureGap: (threadId, error) => transcript.captureProviderGap(threadId, error),
            readThread: (threadId, signal) => bridge.baselineSqliteTranscriptThread(threadId, signal),
            threadIds: bridge.activeSqliteTranscriptThreadIds,
          } : undefined,
          controller.signal,
        );
      })().catch((error) => {
        if (!controller.signal.aborted) reportRecoveryFailure(null, error);
      });
      recovery = { controller, completion };
    };
    const stopRecovery = async () => {
      recovery?.controller.abort(new Error("Codex transcript recovery retired with its bridge."));
      await recovery?.completion;
    };
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
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      onInitialized: build.mode === "initial" ? startRecovery : undefined,
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
          settings: profile.selection.settings, subagentName: profile.subagentName,
          threadId: build.get("threadIdentity").workbenchIdForNative(
            build.get("threadIdentity").knownNativeBinding("codex", thread.id),
          ),
        };
        const resumeRequest = codexInstructions.withThreadConfiguration(requests.resumeRequest, configuration);
        const startRequest = codexInstructions.withThreadConfiguration(requests.startRequest, configuration);
        turnRecovery.observeRequest("codex", resumeRequest);
        turnRecovery.observeRequest("codex", startRequest);
        return { resumeRequest, startRequest };
      },
      prepareTurnStart,
      questionnaires,
      readSqliteContextUsage: (threadId) => build.get("database").readThreadContextUsage(
        build.get("threadIdentity").workbenchIdForNative(
          build.get("threadIdentity").knownNativeBinding("codex", threadId),
        ),
      ),
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
      activate: () => {
        if (build.mode === "replacement") codexMcpGeneration.bump();
        activated = true;
        startRecovery();
      },
      detachForReload: async (replacement) => {
        await stopRecovery();
        const restartingAppServer = replacement.isReplacing("harness:codex");
        if (restartingAppServer) turnRecovery.captureForReload(["codex"]);
        context.onCodexBridgeUnavailable(restartingAppServer);
        const state = await parent.detachBridge(bridge, { restartingAppServer });
        detached = true;
        return state;
      },
      dispose: async () => {
        await stopRecovery();
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
  requires: ["codexAppServer", "codexHealth", "codexInstructions", "codexMcpGeneration", "codexSandboxNetwork", "database", "harnesses", "projectCatalog", "questionnaires", "threadState", "threadIdentity", "transcriptIdentity", "transcript", "transcriptShadowLog", "turnRecovery"],
  safeAll: true,
  scope: "server:codex",
  sources: [
    "daemon/orchestrator/CodexBridgeNode.ts",
    "daemon/orchestrator/codex-sandbox-policy.ts",
    "daemon/orchestrator/CodexStdioBridge.ts",
    "daemon/orchestrator/thread-identity-provider-mapping.ts",
    "daemon/orchestrator/thread-identity-transcript-mapping.ts",
    "daemon/orchestrator/CodexFileChangeController.ts",
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

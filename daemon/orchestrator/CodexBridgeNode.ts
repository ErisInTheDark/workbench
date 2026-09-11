/*
 * Exports:
 * - recoverCodexSqliteTranscripts: repair marked recovery and active baselines independently of harness availability.
 * - default CodexBridgeNode: own reloadable Codex bridge code and questionnaire routing while preserving the parent app-server process.
 */
import CodexStdioBridge from "./CodexStdioBridge";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import { applyServerCodexSandboxPolicy } from "./codex-sandbox-policy";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadCreationProfileSchema } from "workbench-shared/workbench/thread/thread-profile";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import { readWorkbenchPromptContext } from "./workbench-prompt-context";

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
    let generation = new AbortController();
    const persistence = new Set<Promise<unknown>>();
    const persist = async <T>(operation: () => Promise<T>) => {
      const write = operation();
      persistence.add(write);
      try { return await write; }
      finally { persistence.delete(write); }
    };
    const waitForPersistence = async () => {
      while (persistence.size) await Promise.allSettled([...persistence]);
    };
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
          build.mode === "initial" ? async () => undefined : () => harnesses.recoverAvailable("codex", controller.signal),
          build.isReplacing("server:database") ? {
            captureGap: (threadId, error) => persist(() => transcript.captureProviderGap(threadId, error)),
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
    const stopRecovery = () => {
      recovery?.controller.abort(new Error("Codex transcript recovery retired with its bridge."));
      recovery = null;
    };
    const prepareTurnStart = async (
      request: JsonRpcRequest,
      requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
      signal: AbortSignal,
    ) => {
      const reference = typeof record(request.params)?.threadId === "string" ? String(record(request.params)!.threadId).trim() : "";
      if (!reference) throw new Error("Codex turn/start requires a thread id before MCP freshness can be checked.");
      const threadId = NativeThreadIdSchema.parse(reference);
      const state = await threadState.getCodexMcpState(threadId, requestProvider);
      signal.throwIfAborted();
      const [project, networkAccess] = await Promise.all([
        projectCatalog.resolveProjectById(state.projectId),
        codexSandboxNetwork.resolve(state.projectId),
      ]);
      signal.throwIfAborted();
      const generation = await codexMcpGeneration.prepare(state.generation, async () => {
        const response = await requestProvider({
          id: `workbench:mcp-refresh:${codexMcpGeneration.generation}`,
          method: "config/mcpServer/reload",
          params: null,
        });
        if (response.error) throw new Error(response.error.message);
      });
      signal.throwIfAborted();
      await persist(() => threadState.setManagedCodexMcpGeneration(state.projectId, threadId, generation));
      signal.throwIfAborted();
      applyServerCodexSandboxPolicy(
        request,
        project.roots.map((root) => root.rootPath),
        networkAccess,
      );
    };
    const configureProfileRequests = async <T extends { resumeRequest: JsonRpcRequest; startRequest?: JsonRpcRequest }>(
      requests: T,
      profile: Awaited<ReturnType<typeof threadState.readProviderProfile>>,
      threadId: string | null,
      signal: AbortSignal,
    ): Promise<T> => {
        signal.throwIfAborted();
        const project = await projectCatalog.resolveProjectById(profile.projectId);
        signal.throwIfAborted();
        const configuration = {
          cwd: profile.cwd, projectId: profile.projectId,
          roots: project.roots.map((root, index) => ({
            id: root.id, isPrimary: index === 0, name: root.name,
            relativePath: root.relativePath ?? ".", rootPath: root.rootPath,
          })),
          settings: profile.selection.settings, subagentName: profile.subagentName,
          threadId: threadId ? build.get("threadIdentity").workbenchIdForNative(
            build.get("threadIdentity").knownNativeBinding("codex", NativeThreadIdSchema.parse(threadId)),
          ) : null,
        };
        const resumeRequest = codexInstructions.withThreadConfiguration(requests.resumeRequest, configuration);
        turnRecovery.observeRequest("codex", resumeRequest);
        if (!requests.startRequest) return { ...requests, resumeRequest };
        const startRequest = codexInstructions.withThreadConfiguration(requests.startRequest, configuration);
        turnRecovery.observeRequest("codex", startRequest);
        return { ...requests, resumeRequest, startRequest };
    };
    bridge = new CodexStdioBridge({
      ...context.createCodexBridgeOptions(parent.appServer, build.handoffState as CodexStdioBridgeReloadState | undefined),
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      onInitialized: build.mode === "initial" ? startRecovery : undefined,
      instructions: codexInstructions,
      createThread: async (request, create, signal) => {
        const { workbenchCreationProfile, ...nativeRequest } = request;
        if (workbenchCreationProfile === undefined) return create(nativeRequest);
        const source = WorkbenchThreadCreationProfileSchema.parse(workbenchCreationProfile);
        const cwd = record(request.params)?.cwd;
        if (typeof cwd !== "string") throw new Error("Thread creation requires a project cwd.");
        const captured = await threadState.captureCreationProfile("codex", cwd, source);
        const configured = await configureProfileRequests({ resumeRequest: nativeRequest }, {
          ...captured, subagentName: readWorkbenchPromptContext(request)?.subagentName ?? null,
        }, null, signal);
        const response = await create(configured.resumeRequest);
        if (response.error) return response;
        const thread = record(response.result)?.thread as ThreadReadResponse["thread"] | undefined;
        if (!thread) throw new Error("Codex creation returned no thread to store its profile.");
        await threadState.installCreatedProfile("codex", thread, captured.selection);
        return response;
      },
      prepareThreadConfiguration: async (thread, requests, signal) => configureProfileRequests(
        requests, await threadState.readProviderProfile("codex", thread), thread.id, signal,
      ),
      withThreadAdmission: async (thread, requests, admit, signal, fresh) => {
        const outcome = await threadState.withProviderProfileAdmission("codex", thread, async (profile) => (
          admit(await configureProfileRequests(requests, profile, thread.id, signal))
        ), signal, !fresh);
        return outcome.result;
      },
      prepareTurnStart,
      questionnaires,
      readSqliteContextUsage: (threadId) => build.get("database").readThreadContextUsage(
        build.get("threadIdentity").workbenchIdForNative(
          build.get("threadIdentity").knownNativeBinding("codex", NativeThreadIdSchema.parse(threadId)),
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
    return {
      activate: () => {
        parent.attachBridge(bridge, { publish: false });
      },
      deactivate: () => parent.deactivateBridge(bridge),
      afterCommit: () => {
        if (build.isReplacing("harness:codex")) {
          turnRecovery.captureForReload(["codex"]);
          context.onCodexBridgeUnavailable(true);
        }
        parent.attachBridge(bridge);
        if (build.mode === "replacement") codexMcpGeneration.bump();
        bridge.resumePendingToolContexts();
        void bridge.settleRestartedResponses().catch(error => reportRecoveryFailure(null, error));
        build.get("codexHealth").start({ armed: true });
        if (build.mode === "initial") return;
        const signal = generation.signal;
        void parent.appServer.retirePrevious().then(async () => {
          if (!signal.aborted) await context.onCodexBridgeReady(bridge);
        }).then(() => {
          if (!signal.aborted) startRecovery();
        }).catch(error => {
          if (!signal.aborted) reportRecoveryFailure(null, error);
        });
      },
      beginHandoff: (replacement) => {
        const restartingAppServer = replacement.isReplacing("harness:codex");
        const handoff = parent.beginBridgeHandoff(bridge, { restartingAppServer });
        const suspend = () => {
          generation.abort(new Error("Codex bridge node retired."));
          stopRecovery();
        };
        return {
          waitForIdle: async () => {
            suspend();
            await handoff.waitForIdle();
            await waitForPersistence();
          },
          expire: () => { suspend(); handoff.expire(); },
          detach: async () => {
            suspend();
            await waitForPersistence();
            return await handoff.detach();
          },
          resume: async () => {
            generation = new AbortController();
            await handoff.resume();
            startRecovery();
          },
          commit: () => handoff.commit(),
        };
      },
      dispose: async () => {
        generation.abort(new Error("Codex bridge node disposed."));
        stopRecovery();
        bridge.expireForReload();
        await waitForPersistence();
        await bridge.retireAfterHandoff();
      },
      registrations: { codexBridge: bridge },
      start: () => undefined,
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

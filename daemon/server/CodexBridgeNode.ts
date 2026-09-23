/*
 * Exports:
 * - baselineActiveCodexTranscripts: restore demanded active windows after database replacement.
 * - default CodexBridgeNode: own reloadable Codex bridge code and questionnaire routing while preserving the parent app-server process.
 */
import CodexStdioBridge from "./CodexStdioBridge";
import CodexProviderObservations from "./CodexProviderObservations";
import CodexQuestionnaireAdapter from "./CodexQuestionnaireAdapter";
import CodexProvider from "./CodexProvider";
import CodexToolsNode from "./CodexToolsNode";
import CodexThreadOperations from "./CodexThreadOperations";
import CodexConfigurationController from "./CodexConfigurationController";
import CodexHealthMonitor from "./CodexHealthMonitor";
import { log, logError } from "./process-helpers";
import WorkbenchCodexMcpGenerationController from "./WorkbenchCodexMcpGenerationController";
import CodexStoredTranscriptAdapter from "./CodexStoredTranscriptAdapter";
import type { CodexStdioBridgeReloadState } from "./CodexStdioBridge";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import ReloadableNode from "./ReloadableNode";
import OpenCodeProvider from "./providers/opencode/OpenCodeProvider";
import { applyServerCodexSandboxPolicy } from "./codex-sandbox-policy";
import { NativeThreadIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadCreationProfileSchema } from "workbench-shared/workbench/thread/thread-profile";
import type { ThreadReadResponse } from "workbench-shared/codex/generated/app-server/v2/ThreadReadResponse";
import { readWorkbenchPromptContext } from "./workbench-prompt-context";
import { getProcessWorkbenchAgentMcpRequestRegistry } from "./workbench-agent-mcp-request-registry";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function baselineActiveCodexTranscripts(
  reportFailure: (threadId: string | null, error: unknown) => void,
  activeBaseline?: {
    captureGap(threadId: string, error: unknown): Promise<Error>;
    readThread(threadId: string, signal?: AbortSignal): Promise<void>;
    threadIds: readonly string[];
  },
  signal?: AbortSignal,
) {
  for (const threadId of new Set(activeBaseline?.threadIds ?? [])) {
    if (signal?.aborted) return;
    try {
      await activeBaseline!.readThread(threadId, signal);
    } catch (error) {
      if (signal?.aborted) return;
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
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  boundarySources: [
    "daemon/server/codex-transcript-*.ts",
  ].join("\n"),
  children: [CodexProvider, CodexToolsNode, OpenCodeProvider],
  create: (context, build) => {
    const parent = build.get("codexAppServer");
    const restartingAppServer = build.isReplacing("harness:codex");
    const lifecycle = build.get("codexLifecycle");
    const toolRevision = build.get("toolRevision");
    const codexMcpGeneration = new WorkbenchCodexMcpGenerationController(() => toolRevision.revision);
    const codexSandboxNetwork = build.get("codexSandboxNetwork");
    const codexInstructions = build.get("codexInstructions");
    const projectCatalog = build.get("projectCatalog");
    const questionnaires = build.get("questionnaires");
    const transcript = build.get("transcript");
    const threadIdentity = build.get("threadIdentity");
    const threadState = build.get("threadState");
    const sqliteReader = new CodexStoredTranscriptAdapter(build.get("transcriptReader"));
    const turnRecovery = build.get("codexRecovery");
    const requestRegistry = getProcessWorkbenchAgentMcpRequestRegistry();
    let bridge!: CodexStdioBridge;
    let recovery: Promise<void> | null = null;
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
      console.error("[codex-transcript] capture recovery failed", threadId,
        (error instanceof Error ? error.message : String(error)).slice(0, 500));
    };
    const startRecovery = () => {
      if (recovery) return;
      const signal = generation.signal;
      recovery = (async () => {
        await baselineActiveCodexTranscripts(
          reportRecoveryFailure,
          build.isReplacing("server:database") ? {
            captureGap: (threadId, error) => persist(() => transcript.captureProviderGap(threadId, error)),
            readThread: async (threadId, signal) => {
              await build.get("transcriptReconciliation").reconcile({
                threadId, target: { mode: "latest" }, refresh: true,
              }, signal);
            },
            threadIds: bridge.activeSqliteTranscriptThreadIds,
          } : undefined,
          signal,
        );
      })().catch((error) => {
        if (!signal.aborted) reportRecoveryFailure(null, error);
      });
    };
    const prepareTurnStart = async (
      request: JsonRpcRequest,
      requestProvider: (request: JsonRpcRequest) => Promise<JsonRpcResponse>,
      signal: AbortSignal,
    ) => {
      const reference = typeof record(request.params)?.threadId === "string" ? String(record(request.params)!.threadId).trim() : "";
      if (!reference) throw new Error("Codex turn/start requires a thread id before MCP freshness can be checked.");
      const threadId = NativeThreadIdSchema.parse(reference);
      const response = await requestProvider({ id: 0, method: "thread/read", params: { includeTurns: false, threadId } });
      if (response.error) throw new Error(response.error.message);
      const nativeThread = (response.result as ThreadReadResponse | undefined)?.thread;
      if (!nativeThread || nativeThread.id !== threadId) throw new Error("The managed Codex thread could not be read before turn admission.");
      const thread = await threadOperations.observeThread(nativeThread);
      const state = await threadState.getProviderMcpState(thread);
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
      await persist(() => threadState.setProviderMcpGeneration(state.projectId, "codex", threadIdentity.knownThread(ThreadReferenceSchema.parse(thread.id)).threadId, generation));
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
      commandApprovals: build.get("commandApprovals"),
      prepareInputContext: async (nativeThreadId, trigger, inject, signal) => {
        const threadId = threadIdentity.workbenchIdForNative(threadIdentity.knownNativeBinding("codex", nativeThreadId));
        await build.get("agentContext").collect({ harness: "codex", threadId }, trigger, signal, async (_target, text) => {
          await inject(text);
          return "admitted";
        });
      },
      appServer: parent.appServer,
      initialState: build.handoffState as CodexStdioBridgeReloadState | undefined,
      handleWorkbenchRequest: request => request.method === "workbench/subagent/message"
        ? build.run("messages", feature => feature.send(request.params).then(
          () => ({ id: request.id ?? null, result: {} }),
          error => ({
            id: request.id ?? null,
            error: { code: -32000, message: error instanceof Error ? error.message : "Workbench message failed." },
          }),
        ), `messages: ${request.method}`)
        : build.run("subagents", feature => feature.handleRequest(request), `subagents: ${request.method}`),
      resolveProjectFromCwd: (cwd, options) => projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, options),
      onNotification: (notification, facts, nativeNotification) => {
        turnRecovery.observeNotification("codex", nativeNotification);
        context.broadcastProviderNotification("codex", notification);
        void persist(async () => {
          let lifecycle;
          try {
            lifecycle = await build.get("providerObservations").observe("codex", facts);
          } catch (error) {
            await turnRecovery.completeObservedTurn("codex", nativeNotification, null);
            throw error;
          }
          await turnRecovery.completeObservedTurn("codex", nativeNotification, lifecycle);
        }).catch(error => logError("thread-state",
          `failed to observe Codex notification: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`));
      },
      identities: { threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") },
      transcriptAssets: build.get("database"),
      providerObservations: new CodexProviderObservations({ threads: build.get("threadIdentity"), items: build.get("transcriptIdentity") }),
      onAcceptedTurnSteer: nativeThreadId => requestRegistry.interruptThreadWaits(
        threadIdentity.workbenchIdForNative(
          threadIdentity.knownNativeBinding("codex", nativeThreadId),
        ),
      ),
      onInitialized: build.mode === "initial" ? startRecovery : undefined,
      instructions: codexInstructions,
      createThread: async (request, create, signal) => {
        const { workbenchCreationProfile, workbenchCreationLocation, ...nativeRequest } = request;
        if (workbenchCreationProfile === undefined) return create(nativeRequest);
        const source = WorkbenchThreadCreationProfileSchema.parse(workbenchCreationProfile);
        const cwd = record(request.params)?.cwd;
        if (typeof cwd !== "string") throw new Error("Thread creation requires a project cwd.");
        bridge.traceThreadCreation(request.id, "profile-capture");
        const location = workbenchCreationLocation && typeof workbenchCreationLocation === "object"
          ? workbenchCreationLocation as { id: import("workbench-shared/workbench/identity").ProjectId; rootPath: string }
          : null;
        const captured = location
          ? await threadState.captureCreationProfileForProject("codex",
            await projectCatalog.resolveProjectById(location.id), source)
          : await threadState.captureCreationProfile("codex", cwd, source);
        if (location && captured.cwd !== cwd) throw new Error("Captured project location disagrees with native cwd.");
        bridge.traceThreadCreation(request.id, "profile-configuration");
        const configured = await configureProfileRequests({ resumeRequest: nativeRequest }, {
          ...captured, subagentName: readWorkbenchPromptContext(request)?.subagentName ?? null,
        }, null, signal);
        bridge.traceThreadCreation(request.id, "native-creation");
        const response = await create(location
          ? { ...configured.resumeRequest, workbenchCreationLocation: location }
          : configured.resumeRequest);
        if (response.error) return response;
        const thread = record(response.result)?.thread as ThreadReadResponse["thread"] | undefined;
        if (!thread) throw new Error("Codex creation returned no thread to store its profile.");
        bridge.traceThreadCreation(request.id, "profile-installation");
        await threadState.installCreatedProfile("codex", await threadOperations.observeThread(thread, location ?? undefined), captured.selection);
        return response;
      },
      prepareThreadConfiguration: async (thread, requests, signal) => configureProfileRequests(
        requests, await threadState.readProviderProfile("codex", await threadOperations.observeThread(thread)), thread.id, signal,
      ),
      withThreadAdmission: async (thread, requests, admit, signal, fresh) => {
        const outcome = await threadState.withProviderProfileAdmission("codex", await threadOperations.observeThread(thread), async (profile) => (
          admit(await configureProfileRequests(requests, profile, thread.id, signal))
        ), signal, !fresh);
        return outcome.result;
      },
      prepareTurnStart,
      questionnaires: new CodexQuestionnaireAdapter(questionnaires, threadIdentity),
      sqliteReader,
      readSqliteProviderCursor: (threadId, turnId) => build.get("database").readTranscriptProviderCursor!(threadId, turnId),
      readSqliteRecoveryGapIds: async threadId => (await transcript.readRecoveryGaps(WorkbenchThreadIdSchema.parse(threadId))).map(gap => gap.id),
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
      onTranscriptLiveUpdate: update => transcript.acceptLiveUpdate?.(update),
      restartingAppServer,
    });
    const threadOperations = new CodexThreadOperations({
      reconciliation: build.get("transcriptReconciliation"),
      questionnaires,
      bridge,
      identities: { threads: threadIdentity, items: build.get("transcriptIdentity") },
      resolveProject: async cwd => (await projectCatalog.resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Codex provider thread admission" })).project,
    });
    const nativeConfiguration = new CodexConfigurationController({
      request: (method, params, options) => threadOperations.requestNative(method, params, options),
      warn: message => console.warn(message),
    });
    const health = new CodexHealthMonitor({
      failureThreshold: 10,
      intervalMs: 60_000,
      isProbeAllowed: () => build.lease.isCurrent() && parent.isAvailable() && !parent.isTransitioning() && !context.isHardReloadPending(),
      isShuttingDown: () => context.isShuttingDown() || !build.lease.isCurrent(),
      log: message => log("codex-health", message),
      logError: message => logError("codex-health", message),
      probe: signal => persist(async () => {
        await lifecycle.initialize(bridge);
        signal.throwIfAborted();
        const response = await bridge.handleServerRequest(
          { id: "codex-health", method: "account/read", params: {} },
          { signal, timeoutMs: 10_000 },
        );
        if (response.error) throw new Error(response.error.message);
      }),
      requestRecovery: reason => lifecycle.requestRecovery(reason),
    });
    let releaseLiveBoundary: (() => void) | undefined;
    return {
      activate: () => {
        releaseLiveBoundary = transcript.registerLiveBoundary?.(operation => bridge.withTranscriptBoundary(operation));
        parent.attachBridge(bridge, { publish: false });
      },
      deactivate: () => {
        releaseLiveBoundary?.();
        parent.deactivateBridge(bridge);
      },
      afterCommit: () => {
        parent.attachBridge(bridge);
        bridge.resumePendingToolContexts();
        void bridge.settleRestartedResponses().catch(error => reportRecoveryFailure(null, error));
        health.start({ armed: true });
        const signal = generation.signal;
        void parent.waitUntilReady().then(async () => {
          if (!signal.aborted) await lifecycle.ready(bridge);
        }).then(() => {
          if (!signal.aborted) startRecovery();
        }).catch(error => {
          if (!signal.aborted) reportRecoveryFailure(null, error);
        });
      },
      beginHandoff: (replacement) => {
        const nextAppServerRestart = replacement.isReplacing("harness:codex");
        const handoff = parent.beginBridgeHandoff(bridge, { restartingAppServer: nextAppServerRestart });
        const suspend = () => {
          health.dispose();
          generation.abort(new Error("Codex bridge node retired."));
          return recovery;
        };
        return {
          waitForIdle: async () => {
            await suspend();
            await handoff.waitForIdle();
            await waitForPersistence();
          },
          expire: () => { void suspend(); handoff.expire(); },
          detach: async () => {
            await suspend();
            await waitForPersistence();
            return await handoff.detach();
          },
          resume: async () => {
            await recovery;
            recovery = null;
            generation = new AbortController();
            await handoff.resume();
            health.start({ armed: true });
            startRecovery();
          },
          commit: () => handoff.commit(),
        };
      },
      dispose: async () => {
        health.dispose();
        releaseLiveBoundary?.();
        generation.abort(new Error("Codex bridge node disposed."));
        await recovery;
        bridge.expireForReload();
        await waitForPersistence();
        await bridge.retireAfterHandoff();
      },
      hasPendingWork: () => bridge.hasPendingWork() || persistence.size > 0,
      registrations: { codexBridge: bridge, codexThreadOperations: threadOperations, codexNativeConfiguration: nativeConfiguration },
      start: () => undefined,
    };
  },
  description: "Reload Codex bridge code without restarting the Codex app-server.",
  lifecycle: "handoff",
  provides: ["codexBridge", "codexThreadOperations", "codexNativeConfiguration"],
  requires: ["codexAppServer", "codexLifecycle", "codexInstructions", "toolRevision", "codexSandboxNetwork", "database", "commandApprovals", "projectCatalog", "questionnaires", "threadState", "threadIdentity", "transcriptIdentity", "transcript", "transcriptReader", "transcriptReconciliation", "codexRecovery", "providerObservations", "agentContext"],
  safeAll: true,
  scope: "server:codex",
  sources: [
    "daemon/server/CodexBridgeNode.ts",
    "daemon/server/CodexThreadOperations.ts",
    "daemon/server/CodexConfigurationController.ts",
    "daemon/server/WorkbenchCodexMcpGenerationController.ts",
    "daemon/server/codex-sandbox-policy.ts",
    "daemon/server/CodexStdioBridge.ts",
    "daemon/server/CodexProviderObservations.ts",
    "daemon/server/CodexProviderIdentity.ts",
    "daemon/server/CodexPublicIdentity.ts",
    "daemon/server/thread-identity-transcript-mapping.ts",
    "daemon/server/CodexFileChangeController.ts",
    "daemon/server/CodexThreadWindowLoader.ts",
    "daemon/server/CodexStoredTranscriptAdapter.ts",
    "daemon/server/CodexThreadPageReadController.ts",
    "shared/workbench/thread/workbench-thread-page.ts",
    "daemon/server/workbench-agent-mcp-request-registry.ts",
    "daemon/server/CodexBridgeTransitionController.ts",
    "daemon/server/CodexHealthMonitor.ts",
  ].join("\n"),
});

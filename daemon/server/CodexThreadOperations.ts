/*
 * Exports:
 * - CodexThreadOperationOwners: existing bridge, project and identity admission ports.
 * - default CodexThreadOperations: translate WB thread intent into existing Codex admission, read, and interaction owners.
 */
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { Turn as NativeTurn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { createInitializeCapabilities, createInitializeRequest } from "workbench-shared/codex/protocol";
import { toThreadPayload, toThreadTurn } from "workbench-shared/codex/thread-adapter";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { WorkbenchThreadHistoryPendingError } from "workbench-shared/workbench/provider/provider-thread";
import type {
  ThreadPayload, WorkbenchPendingUserInputRequest,
} from "workbench-shared/types";
import type {
  WorkbenchProviderThreadCreate, WorkbenchProviderThreadList, WorkbenchProviderThreads, WorkbenchProviderTranscriptReconcile,
} from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchThreadMessage, WorkbenchThreadMessageResult } from "workbench-shared/workbench/thread/thread-actions";
import { WorkbenchThreadMessageResultSchema } from "workbench-shared/workbench/thread/thread-actions";
import { WorkbenchProviderGoalSchema, type WorkbenchProviderGoalUpdate } from "workbench-shared/workbench/provider/provider-goal";

import { NativeThreadIdSchema, ThreadReferenceSchema, TurnReferenceSchema, type ProjectId } from "workbench-shared/workbench/identity";
import { admitProviderNotifications, admitProviderThreads, mapProviderThread } from "./CodexProviderIdentity";
import type { NativeTranscriptIdentityOwners } from "./thread-identity-transcript-mapping";
import { mapNativeProviderResponse, mapWorkbenchProviderRequest } from "./CodexPublicIdentity";
import type CodexStdioBridge from "./CodexStdioBridge";
import type WorkbenchQuestionnaireController from "./WorkbenchQuestionnaireController";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { createWorkbenchAgentMessageOutput } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchProviderBrowse } from "workbench-shared/workbench/provider/provider-browse";
import { WORKBENCH_TOOL_CONTEXT_METHOD, WorkbenchToolContextResponseSchema } from "workbench-shared/workbench/thread/thread-tool-output";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";
import type WorkbenchTranscriptReconciliationController from "./WorkbenchTranscriptReconciliationController";
import type { WorkbenchProviderContext } from "workbench-shared/workbench/provider/provider-context";

export interface CodexThreadOperationOwners {
  bridge: Pick<CodexStdioBridge, "canDeliverQuestionnaire" | "ensureInitialized" | "handleServerRequest" | "reconcileSqliteTranscriptWindow" | "injectAgentContext">;
  reconciliation: Pick<WorkbenchTranscriptReconciliationController, "reconcile">;
  identities: NativeTranscriptIdentityOwners;
  resolveProject(cwd: string): Promise<{ id: ProjectId; rootPath: string }>;
  questionnaires?: Pick<WorkbenchQuestionnaireController, "canDeliver" | "deliver" | "interruptRetainingQuestionnaire">;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export default class CodexThreadOperations implements WorkbenchProviderThreads {
  constructor(private readonly owners: CodexThreadOperationOwners) {}

  readonly context: WorkbenchProviderContext = {
    inject: async (input, signal) => {
      const threadId = await this.nativeThreadId(input.threadId);
      await this.owners.bridge.injectAgentContext(threadId, input.text, signal);
      return "admitted";
    },
  };

  async reconcile(input: WorkbenchProviderTranscriptReconcile, signal: AbortSignal) {
    signal.throwIfAborted();
    return this.owners.bridge.reconcileSqliteTranscriptWindow(input, signal);
  }

  private async nativeThreadId(threadId: string) {
    const mapped = await mapWorkbenchProviderRequest(this.owners.identities.threads, "codex", {
      method: "thread/read", params: { threadId },
    });
    return NativeThreadIdSchema.parse(record(mapped.request.params)?.threadId);
  }

  private async workbenchThreadId(threadId: string) {
    const thread = await this.owners.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse(threadId) });
    if (!thread) throw new Error("The questionnaire thread has no admitted identity.");
    return thread.threadId;
  }

  async resolvePatchCaller(threadId: string, cwd: string) {
    const project = await this.owners.resolveProject(cwd);
    const thread = await this.owners.identities.threads.resolve({
      threadId: ThreadReferenceSchema.parse(threadId), harness: "codex", projectId: project.id,
    });
    const binding = thread?.bindings.find(binding => binding.harness === "codex");
    if (!thread || !binding) throw new Error("The patch caller has no Codex execution in this project.");
    return { threadId: thread.threadId, nativeThreadId: binding.nativeThreadId };
  }

  private interactionResult(value: unknown) {
    const warning = record(value)?.warning;
    return typeof warning === "string" && warning.trim() ? { warning: warning.slice(0, 500) } : {};
  }

  readonly interactions: WorkbenchProviderInteractions = {
    interruptRetaining: async (input, isCurrent) => {
      const questionnaires = this.owners.questionnaires;
      if (!questionnaires) throw new Error("Questionnaire interruption is unavailable.");
      const threadId = await this.workbenchThreadId(input.threadId);
      return questionnaires.interruptRetainingQuestionnaire(threadId, input.requestKey, async () => {
        if (!await isCurrent()) return false;
        if (!input.turnId) return true;
        await this.clearGoal(input.threadId);
        if (!await isCurrent()) return false;
        await this.mapped({ method: "turn/interrupt", params: { threadId: input.threadId, turnId: input.turnId } });
        return isCurrent();
      });
    },
    pending: async options => {
      const result = await this.mapped({
        method: "questionnaire/list", params: {},
        ...(options?.background ? { workbenchRequestSource: "autoRefresh" as const } : {}),
      }) as { data: Omit<WorkbenchPendingUserInputRequest, "harness">[] };
      return result.data.map(request => ({ ...request, harness: "codex" }));
    },
    canDeliver: async (threadId, requestKey) => {
      const nativeId = await this.nativeThreadId(threadId);
      return this.owners.bridge.canDeliverQuestionnaire(nativeId, requestKey)
        || (this.owners.questionnaires?.canDeliver(await this.workbenchThreadId(threadId), requestKey) ?? false);
    },
    deliver: async input => {
      const threadId = await this.workbenchThreadId(input.threadId);
      return Boolean(await this.owners.questionnaires?.deliver({ ...input, threadId }));
    },
    respond: async input => this.interactionResult(await this.mapped({
      method: "questionnaire/respond", params: input,
    })),
    supplement: async input => {
      await this.mapped({
        method: "turn/steer",
        params: { threadId: input.threadId, expectedTurnId: input.turnId, input: input.input },
        ...(input.activatedSkillPaths.length ? {
          workbenchPromptContext: { activatedSkillPaths: input.activatedSkillPaths },
        } : {}),
      });
    },
    record: async entry => this.interactionResult(await this.mapped({
      method: "questionnaire/history/record", params: entry,
    })),
  };

  readonly history: WorkbenchProviderThreads["history"] = {
    materialize: async (threadId, turnId, signal) => {
      signal.throwIfAborted();
      await this.owners.reconciliation.reconcile({
        threadId, target: turnId ? { mode: "exact", turnId } : { mode: "latest" }, refresh: false,
      }, signal);
    },
  };

  readonly browse: WorkbenchProviderBrowse = {
    record: async entry => {
      await this.mapped({ method: "browse/result/record", params: entry });
    },
    screenshot: async input => {
      const result = WorkbenchToolContextResponseSchema.parse(await this.mapped({
        method: WORKBENCH_TOOL_CONTEXT_METHOD,
        params: {
          threadId: input.threadId, expectedTurnId: input.turnId,
          toolOutput: { name: "screenshot", namespace: "workbench", output: [
            { type: "input_text", text: createAgentScreenshotSteerText() },
            { type: "input_image", image_url: input.imageUrl },
          ] },
        },
      }));
      return { kind: "injected", acceptedAt: result.acceptedAt, turnId: input.turnId };
    },
  };

  async requestNative(method: string, params: object, options?: { background?: boolean }): Promise<unknown> {
    return this.result(await this.dispatch({
      id: 0, method, params, ...(options?.background ? { workbenchRequestSource: "autoRefresh" as const } : {}),
    }));
  }

  private async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    await this.owners.bridge.ensureInitialized(createInitializeRequest(0, {
      capabilities: createInitializeCapabilities({ experimentalApi: true }),
    }));
    return this.owners.bridge.handleServerRequest(request);
  }

  private result(response: JsonRpcResponse) {
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  async observeThread(thread: Thread, location?: { id: import("workbench-shared/workbench/identity").ProjectId; rootPath: string }): Promise<ThreadPayload> {
    const native = { harness: "codex", nativeLocation: thread.cwd, nativeThreadId: NativeThreadIdSchema.parse(thread.id) };
    const retained = this.owners.identities.threads.findNativeThread(native);
    const project = location ?? (retained
      ? { id: retained.projectId, rootPath: retained.projectRoot }
      : await this.owners.resolveProject(thread.cwd));
    await admitProviderThreads(this.owners.identities, [{
      thread,
      metadata: {
        native, projectId: project.id, projectRoot: project.rootPath,
        title: thread.name ?? "",
        createdAt: Math.round(thread.createdAt * 1_000),
        updatedAt: Math.round(thread.updatedAt * 1_000),
        activityAt: Math.round(thread.updatedAt * 1_000),
      },
    }]);
    return {
      ...toThreadPayload(mapProviderThread(this.owners.identities, native, thread), "codex", thread.model, thread.reasoningEffort),
      recencyAt: thread.recencyAt,
      isDraft: false,
    };
  }

  private async mapped(request: JsonRpcRequest) {
    try {
      return await this.mappedResponse(request);
    } catch (error) {
      if (request.method === "thread/read" || request.method === "thread/context/read") {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (message.includes("rollout at") && message.includes("is empty")
          || message.includes("no rollout found by id") || message.includes("no rollout found for thread id")) {
          throw new WorkbenchThreadHistoryPendingError("Thread history is still becoming available.");
        }
      }
      throw error;
    }
  }

  private async mappedResponse(request: JsonRpcRequest) {
    const { request: native } = await mapWorkbenchProviderRequest(this.owners.identities.threads, "codex", request);
    const response = await this.dispatch(native);
    this.result(response);
    const result = record(response.result);
    if (result?.thread && request.method !== "thread/context/read") {
      await this.observeThread(result.thread as Thread);
    }
    const turns = result?.turn ? [result.turn as NativeTurn]
      : request.method === "thread/turns/list" && Array.isArray(result?.data) ? result.data as NativeTurn[] : [];
    if (turns.length) {
      const threadId = String(record(native.params)?.threadId ?? "");
      await admitProviderNotifications(this.owners.identities,
        this.owners.identities.threads.knownNativeBinding("codex", NativeThreadIdSchema.parse(threadId)),
        turns.map(turn => ({ method: "turn/started", params: { threadId, turn } })),
      );
    }
    return this.result(await mapNativeProviderResponse(this.owners.identities, "codex", native, response));
  }

  async create(input: WorkbenchProviderThreadCreate): Promise<ThreadPayload> {
    const writableRoots = [...new Set([...(input.projectRoots ?? [input.cwd]), ...(input.additionalWritableRoots ?? [])].filter(Boolean))];
    const sandbox = writableRoots.length > 1 || Boolean(input.additionalWritableRoots?.length)
      ? {
        sandbox: "workspace-write",
        config: { sandbox_workspace_write: {
          writable_roots: writableRoots, network_access: false,
          exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
        } },
      } : {};
    const response = await this.dispatch({
      id: 0,
      method: "thread/start",
      params: { cwd: input.cwd, ephemeral: false, ...sandbox },
      workbenchCreationProfile: { kind: "snapshot", selection: input.profile },
      ...(input.projectLocation ? { workbenchCreationLocation: input.projectLocation } : {}),
      workbenchPromptContext: { ...input.context, cwd: input.cwd, harness: "codex" },
    });
    const thread = record(this.result(response))?.thread as Thread | undefined;
    if (!thread) throw new Error("Codex creation returned no thread.");
    return this.observeThread(thread, input.projectLocation);
  }

  async list(input: WorkbenchProviderThreadList) {
    const response = await this.dispatch({
      id: 0,
      method: "thread/list",
      params: {
        cwd: input.cwd, cursor: input.cursor ?? null, limit: input.limit ?? 50,
        archived: input.archived ?? false, sortKey: "updated_at", sortDirection: "desc",
        useStateDbOnly: true,
      },
      ...(input.background ? { workbenchRequestSource: "autoRefresh" } : {}),
    });
    const result = this.result(response) as { data: Thread[]; nextCursor: string | null };
    return { data: await Promise.all(result.data.map(thread => this.observeThread(thread))), nextCursor: result.nextCursor };
  }

  async read(threadId: string, options?: { background?: boolean }): Promise<ThreadPayload> {
    const scheduling = options?.background ? { workbenchRequestSource: "autoRefresh" as const } : {};
    const known = await this.owners.identities.threads.resolve({ threadId: ThreadReferenceSchema.parse(threadId), harness: "codex" });
    if (!known) {
      const response = this.result(await this.dispatch({
        method: "thread/read", params: { threadId, includeTurns: false }, ...scheduling,
      })) as { thread: Thread };
      if (!response.thread || response.thread.id !== threadId) throw new Error("Provider metadata returned a different thread.");
      return this.observeThread(response.thread);
    }
    const result = await this.mapped({ id: 0, method: "thread/read", params: { threadId, includeTurns: false }, ...scheduling }) as { thread: Thread };
    return {
      ...toThreadPayload(result.thread, "codex", result.thread.model, result.thread.reasoningEffort),
      recencyAt: result.thread.recencyAt,
      id: this.owners.identities.threads.knownThread(ThreadReferenceSchema.parse(result.thread.id)).threadId,
      isDraft: false,
    };
  }

  async latestTurn(threadId: string): Promise<Turn | null> {
    const result = await this.mapped({
      method: "thread/turns/list",
      params: { threadId, itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
    }) as { data: Turn[] };
    const turn = result.data[0];
    if (!turn) return null;
    if (!["inProgress", "completed", "interrupted", "failed"].includes(turn.status)) {
      throw new Error("Codex returned unrecognised turn metadata.");
    }
    return toThreadTurn(turn, "codex");
  }

  async readLatest(threadId: string): Promise<ThreadPayload> {
    const { thread } = await this.mapped({
      method: "thread/context/read", params: { threadId, includeTurns: false },
      workbenchThreadHydration: { mode: "latest" },
    }) as { thread: Thread };
    return {
      ...toThreadPayload(thread, "codex", thread.model, thread.reasoningEffort),
      id: this.owners.identities.threads.knownThread(ThreadReferenceSchema.parse(thread.id)).threadId,
      isDraft: false,
    };
  }

  async messageAgent(input: Parameters<WorkbenchProviderThreads["messageAgent"]>[0]) {
    await this.mapped({
      method: "turn/start",
      params: {
        threadId: input.threadId, cwd: input.cwd, input: [],
        toolOutput: createWorkbenchAgentMessageOutput(input.message),
        ...(input.context?.subagentName ? {
          collaborationMode: { mode: "plan", settings: { developer_instructions: "" } },
          summary: "detailed",
        } : {}),
      },
      ...(input.context ? { workbenchPromptContext: {
        ...input.context, cwd: input.cwd, threadId: input.threadId, harness: "codex",
      } } : {}),
    });
  }

  async admitTurn(threadId: string, turnReference: string) {
    const identities = this.owners.identities;
    const thread = await identities.threads.resolve({ threadId: ThreadReferenceSchema.parse(threadId), harness: "codex" });
    if (!thread) throw new Error("Thread metadata is unavailable for turn identity resolution.");
    const turnId = TurnReferenceSchema.parse(turnReference);
    if (await identities.threads.resolveTurn({ threadId: thread.threadId, turnId })) return;
    const native = thread.bindings.find(binding => binding.harness === "codex" && binding.nativeThreadId === threadId)
      ?? thread.bindings.find(binding => binding.harness === "codex");
    if (!native) throw new Error("Turn identity has no admitted native thread.");
    let cursor: string | null = null;
    do {
      const result = this.result(await this.dispatch({
        method: "thread/turns/list",
        params: { threadId: native.nativeThreadId, cwd: native.nativeLocation, itemsView: "notLoaded", limit: 100, sortDirection: "asc", cursor },
      })) as { data: NativeTurn[]; nextCursor: string | null };
      if (!result || !Array.isArray(result.data)) throw new Error("Provider turn metadata response is invalid.");
      await admitProviderNotifications(identities, native, result.data.map(turn => ({
        method: "turn/started" as const, params: { threadId: native.nativeThreadId, turn },
      })));
      if (await identities.threads.resolveTurn({ threadId: thread.threadId, turnId })) return;
      if (result.nextCursor !== null && result.nextCursor === cursor) throw new Error("Provider turn metadata cursor did not advance.");
      cursor = result.nextCursor;
    } while (cursor);
    throw new Error("Referenced turn is absent from the provider metadata catalog.");
  }

  async submit(input: WorkbenchThreadMessage): Promise<WorkbenchThreadMessageResult> {
    const context = { ...input.context, harness: "codex", threadId: input.threadId };
    if (input.intent === "steer") {
      const result = await this.mapped({
        id: 0, method: "turn/steer",
        params: {
          threadId: input.threadId, expectedTurnId: input.expectedTurnId,
          clientUserMessageId: input.clientMessageId, input: input.input,
        },
        workbenchPromptContext: context,
      }) as { turnId: string };
      return { kind: "steered", turnId: result.turnId };
    }
    const startRequest = {
      method: "turn/start",
      params: { threadId: input.threadId, clientUserMessageId: input.clientMessageId, input: input.input, summary: "detailed" },
      workbenchPromptContext: context,
    };
    const result = await this.mapped({
      id: 0,
      method: "workbench/codex/message/admit",
      params: {
        threadId: input.threadId,
        resumeRequest: {
          method: "thread/resume",
          params: {
            threadId: input.threadId,
            excludeTurns: true,
            initialTurnsPage: { itemsView: "notLoaded", limit: 1, sortDirection: "desc" },
          },
          workbenchPromptContext: context,
        },
        startRequest,
        ...(input.intent === "continue" ? {
          steerRequest: { method: "turn/steer", params: {}, workbenchPromptContext: context },
        } : {}),
      },
    });
    return WorkbenchThreadMessageResultSchema.parse(result);
  }

  async rename(threadId: string, title: string) {
    await this.mapped({ id: 0, method: "thread/name/set", params: { threadId, name: title } });
  }

  async compact(threadId: string) {
    await this.mapped({ id: 0, method: "thread/compact/start", params: { threadId } });
  }

  async delete(threadId: string) {
    await this.mapped({ id: 0, method: "thread/delete", params: { threadId } });
  }

  async readGoal(threadId: string) {
    const result = record(await this.mapped({ id: 0, method: "thread/goal/get", params: { threadId } }));
    return this.goal(threadId, result?.goal);
  }

  async updateGoal(input: WorkbenchProviderGoalUpdate) {
    const result = record(await this.mapped({ id: 0, method: "thread/goal/set", params: input }));
    return this.goal(input.threadId, result?.goal);
  }

  async clearGoal(threadId: string) {
    await this.mapped({ id: 0, method: "thread/goal/clear", params: { threadId } });
  }

  private goal(threadId: string, value: unknown) {
    if (value === null || value === undefined) return null;
    return {
      ...WorkbenchProviderGoalSchema.parse(value),
      threadId: this.owners.identities.threads.knownThread(ThreadReferenceSchema.parse(threadId)).threadId,
    };
  }

  async interrupt(threadId: string, turnId: string, options?: { preserveGoal?: boolean }) {
    if (!options?.preserveGoal) await this.mapped({ id: 0, method: "thread/goal/clear", params: { threadId } });
    await this.mapped({ id: 0, method: "turn/interrupt", params: { threadId, turnId } });
  }

  async materialize(threadId: string, turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    for (const turnId of turnIds) await this.owners.reconciliation.reconcile({
      threadId, target: { mode: "exact", turnId }, refresh: false,
    }, signal);
  }
}

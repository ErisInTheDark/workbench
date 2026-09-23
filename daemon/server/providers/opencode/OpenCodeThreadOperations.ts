/*
 * Exports:
 * - OpenCodeThreadOperationsOptions: provider-local dependencies for native session operations.
 * - default OpenCodeThreadOperations: translate WB thread intent to the pinned OpenCode client and canonical SQL history.
 */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { SessionInboxInfo, SessionInfo, SessionMessageInfo, SessionMessageUser } from "@opencode/client";
import {
  NativeThreadIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema,
  type WorkbenchThreadId, type WorkbenchTurnId, WorkbenchTurnIdSchema, TurnReferenceSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads, WorkbenchProviderTranscriptReconcile } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchThreadMessageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchTextInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import type WorkbenchTranscriptReader from "../../WorkbenchTranscriptReader";
import type { WorkbenchProviderCaller, WorkbenchToolTranscript, WorkbenchToolTranscriptReference, ProviderToolResult } from "workbench-shared/workbench/provider/provider-execution";
import type { OpenCodeToolContext } from "./opencode-workbench-rpc";
import OpenCodeThreadWindowLoader from "./OpenCodeThreadWindowLoader";
import type WorkbenchTranscriptReconciliationController from "../../WorkbenchTranscriptReconciliationController";
import type WorkbenchTurnRecoveryController from "../../WorkbenchTurnRecoveryController";
import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import { createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput } from "workbench-shared/workbench/thread/thread-recovery-message";

type OpenCodeSteerEntry = Omit<WorkbenchSteerHistoryEntry, "threadId" | "turnId"> & {
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
};

function steerInput(inputs: readonly WorkbenchUserInput[]): WorkbenchSteerHistoryEntry["input"] {
  return inputs.map((input) => {
    if (input.type !== "text") return { ...input };
    return {
      ...input,
      text_elements: input.text_elements.map(element => ({
        ...element,
        placeholder: element.placeholder ?? "",
      })),
    };
  });
}

export interface OpenCodeThreadOperationsOptions {
  acquire: () => Promise<WorkbenchOpenCodeClient>;
  observe: (facts: WorkbenchProviderObservation) => Promise<void>;
  identities: WorkbenchThreadIdentityController;
  projects: Pick<WorkbenchProjectCatalogController, "resolveAgentEndpointProjectFromCwd" | "resolveProjectById">;
  questionnaires: Pick<
    WorkbenchQuestionnaireController,
    "canDeliver" | "deliver" | "interruptRetainingQuestionnaire"
  >;
  state: Pick<WorkbenchThreadStateFeature, "controller" | "installCreatedProfile">;
  managed: Pick<OpenCodeManagedSessionController, "creation" | "refresh">;
  transcript: OpenCodeTranscriptAdapter;
  reader: Pick<WorkbenchTranscriptReader, "readPage">;
  signal: AbortSignal;
  reconciliation: Pick<WorkbenchTranscriptReconciliationController, "reconcile">;
  readProviderCursor(threadId: string, turnId: string): Promise<string | null | undefined>;
  recovery: Pick<WorkbenchTurnRecoveryController, "shouldContinue">;
}

interface SessionExecution {
  active: boolean;
  turn: { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null;
  eventSequence: number;
  intentVersion: number;
  context?: Parameters<WorkbenchProviderThreads["submit"]>[0]["context"];
  admission: Promise<void> | null;
}
const supersededContinuation = Symbol("superseded OpenCode continuation");

function modelRef(model: string) {
  const separator = model.indexOf("/");
  return separator > 0 ? { providerID: model.slice(0, separator), id: model.slice(separator + 1) } : undefined;
}

function prompt(input: readonly WorkbenchUserInput[]) {
  const text: string[] = [];
  const files: { uri: string; name?: string }[] = [];
  for (const part of input) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "skill" || part.type === "mention") text.push(`@${part.name} (${part.path})`);
    else if (part.type === "localImage" || part.type === "localAudio") files.push({ uri: pathToFileURL(part.path).href });
    else files.push({ uri: part.url });
  }
  return { text: text.join("\n"), ...(files.length ? { files } : {}) };
}

function nativeMessageId(clientMessageId: string) {
  return clientMessageId.startsWith("msg_") ? clientMessageId : `msg_${clientMessageId}`;
}

function isManagedWorkbenchPrompt(item: SessionInboxInfo) {
  if (item.type !== "user") return false;
  const metadata = item.payload.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const workbench = metadata.workbench;
  return Boolean(workbench && typeof workbench === "object" && !Array.isArray(workbench));
}

function openCodeFailure(operation: string, error: unknown) {
  if (error instanceof Error) return error;
  if (!error || typeof error !== "object") return new Error(`OpenCode ${operation} failed.`);
  const failure = error as Record<string, unknown>;
  const tag = typeof failure._tag === "string" && /^[A-Za-z][A-Za-z0-9]+$/u.test(failure._tag)
    ? failure._tag : "protocol error";
  const details = [
    typeof failure.kind === "string" ? `kind ${failure.kind.slice(0, 80)}` : null,
    typeof failure.field === "string" ? `field ${failure.field.slice(0, 80)}` : null,
  ].filter(Boolean).join(", ");
  const message = typeof failure.message === "string" ? failure.message.slice(0, 300) : "";
  return new Error(`OpenCode ${operation} failed (${tag}${details ? `, ${details}` : ""})${message ? `: ${message}` : "."}`);
}

export default class OpenCodeThreadOperations implements WorkbenchProviderThreads {
  hasPendingWork() {
    return this.pendingCreations.size > 0 || this.pendingPrompts.size > 0 || this.pendingSteerSessions.size > 0
      || [...this.executions.values()].some(execution => execution.active || execution.admission !== null);
  }
  private readonly executions = new Map<string, SessionExecution>();
  private readonly pendingPrompts = new Set<Promise<void>>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly pendingCreations = new Set<Promise<ThreadPayload>>();
  private readonly deferredCreatedSessions = new Set<string>();
  private readonly pendingSteers = new Map<string, Map<string, WorkbenchSteerHistoryEntry>>();
  private readonly pendingSteerSessions = new Map<string, Set<string>>();
  private readonly requestedInterruptions = new Set<string>();

  readonly history = {
    materialize: async (threadId: string, turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      await this.demand(threadId, turnId ? { mode: "exact", turnId } : { mode: "latest" }, false, signal);
    },
  };

  constructor(private readonly options: OpenCodeThreadOperationsOptions) {}

  readonly interactions: WorkbenchProviderInteractions = {
    pending: async () => [],
    canDeliver: async (threadId, requestKey) => this.options.questionnaires.canDeliver(
      WorkbenchThreadIdSchema.parse(threadId),
      requestKey,
    ),
    deliver: async input => Boolean(await this.options.questionnaires.deliver({
      ...input,
      threadId: WorkbenchThreadIdSchema.parse(input.threadId),
    })),
    interruptRetaining: async (input, isCurrent) => this.options.questionnaires.interruptRetainingQuestionnaire(
      WorkbenchThreadIdSchema.parse(input.threadId),
      input.requestKey,
      async () => {
        if (!await isCurrent()) return false;
        const { binding } = await this.native(input.threadId);
        if (!await isCurrent()) return false;
        await this.interruptSession(input.threadId, binding.nativeThreadId);
        return isCurrent();
      },
    ),
    respond: async () => {
      throw new Error("OpenCode does not own provider-native questionnaire responses.");
    },
    supplement: async input => {
      await this.submit({
        threadId: input.threadId,
        clientMessageId: randomUUID(),
        input: input.input,
        intent: "steer",
        expectedTurnId: input.turnId,
        context: { activatedSkillPaths: input.activatedSkillPaths },
      });
    },
    record: async entry => {
      await this.options.transcript.recordQuestionnaire(entry);
      return {};
    },
  };

  async create(input: Parameters<WorkbenchProviderThreads["create"]>[0]) {
    const operation = this.createOwned(input);
    this.pendingCreations.add(operation);
    try {
      return await operation;
    } finally {
      while (this.pendingCreations.size === 1 && this.deferredCreatedSessions.size) {
        const sessionId = this.deferredCreatedSessions.values().next().value!;
        this.deferredCreatedSessions.delete(sessionId);
        if (!this.sessions.has(sessionId)) {
          console.error("[opencode] early session could not be correlated to a captured creation.");
          continue;
        }
        try { await this.syncNative(sessionId); }
        catch (error) {
          console.error(`[opencode] deferred session admission failed: ${
            error instanceof Error ? error.message.slice(0, 500) : "unknown failure"
          }`);
        }
      }
      this.pendingCreations.delete(operation);
    }
  }

  private async createOwned(input: Parameters<WorkbenchProviderThreads["create"]>[0]) {
    const client = await this.options.acquire();
    const project = input.projectLocation
      ? await this.options.projects.resolveProjectById(input.projectLocation.id)
      : (await this.options.projects.resolveAgentEndpointProjectFromCwd(
        input.cwd, { endpointName: "OpenCode provider thread admission" },
      )).project;
    if (input.projectLocation && project.rootPath !== input.cwd) {
      throw new Error("OpenCode creation target disagrees with its captured project.");
    }
    const settings = input.profile.settings;
    const session = await client.session.create({
      location: { directory: input.cwd },
      ...(settings.model ? { model: modelRef(settings.model) } : {}),
      ...this.options.managed.creation(),
    });
    this.sessions.set(session.id, session);
    const identity = await this.options.transcript.record(session, [], {
      id: project.id, rootPath: project.rootPath,
      ...(input.projectLocation?.launchId ? { launchId: input.projectLocation.launchId } : {}),
    });
    const thread = await this.read(identity.threadId);
    await this.options.state.installCreatedProfile("opencode", thread, input.profile);
    return thread;
  }

  async syncCreatedNative(nativeThreadId: string) {
    if (this.pendingCreations.size && !this.sessions.has(nativeThreadId)) {
      this.deferredCreatedSessions.add(nativeThreadId);
      return null;
    }
    return await this.syncNative(nativeThreadId);
  }

  async list(input: Parameters<WorkbenchProviderThreads["list"]>[0]) {
    const client = await this.options.acquire();
    const response = await client.session.list({
      directory: input.cwd,
      cursor: input.cursor ?? undefined,
      limit: input.limit,
      order: "desc",
    });
    const data = [];
    for (const session of response.data) {
      const identity = await this.syncSession(session, []);
      data.push(await this.readHydratedThread(identity.threadId));
    }
    return { data, nextCursor: response.cursor.next ?? null };
  }

  async read(threadId: string) {
    const identity = await this.identity(threadId);
    return await this.readHydratedThread(identity.threadId);
  }

  private async readHydratedThread(threadId: WorkbenchThreadId) {
    const { thread } = await this.options.reader.readPage({ threadId, cursor: null });
    const activeTurn = [...thread.turns].reverse().find(turn => turn.status === "inProgress");
    if (activeTurn) {
      const identity = await this.options.identities.resolveTurn({
        threadId, turnId: TurnReferenceSchema.parse(activeTurn.id),
      });
      if (!identity || identity.threadId !== threadId) {
        throw new Error("The canonical active turn does not belong to this Workbench thread.");
      }
    }
    return thread;
  }

  async readLatest(threadId: string) {
    await this.sync(threadId);
    return this.read(threadId);
  }

  async latestTurn(threadId: string) {
    return (await this.readLatest(threadId)).turns.at(-1) ?? null;
  }

  async admitTurn(threadId: string) {
    await this.sync(threadId);
  }

  async submit(input: Parameters<WorkbenchProviderThreads["submit"]>[0]): Promise<WorkbenchThreadMessageResult> {
    const native = await this.native(input.threadId);
    const execution = this.execution(native.binding.nativeThreadId);
    execution.intentVersion++;
    const context = {
      ...input.context,
      activatedSkillPaths: [...new Set([
        ...(input.context?.activatedSkillPaths ?? []),
        ...input.input.flatMap(part => part.type === "skill" ? [part.path] : []),
      ])],
    };
    execution.context = context;
    return this.admit(execution, () => this.submitNative({ ...input, context }, native, execution));
  }

  private async admit<T>(execution: SessionExecution, operation: () => Promise<T>): Promise<T> {
    const previous = execution.admission;
    const release = Promise.withResolvers<void>();
    execution.admission = release.promise;
    try {
      await previous;
      this.options.signal.throwIfAborted();
      return await operation();
    } finally {
      if (execution.admission === release.promise) execution.admission = null;
      release.resolve();
    }
  }

  private async submitNative(
    input: Parameters<WorkbenchProviderThreads["submit"]>[0],
    { binding, identity }: Awaited<ReturnType<OpenCodeThreadOperations["native"]>>,
    execution: SessionExecution,
    continuation?: () => boolean,
  ): Promise<WorkbenchThreadMessageResult> {
    const client = await this.options.acquire();
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    if (continuation && (!continuation() || !entry || entry.entryKind === "draft"
      || !this.options.recovery.shouldContinue(entry.lifecycle, false))) throw supersededContinuation;
    let session = this.sessions.get(binding.nativeThreadId);
    if (!session || !execution.turn) {
      const [freshSession, inbox, stored] = await Promise.all([
        client.session.get({ sessionID: binding.nativeThreadId }, { signal: this.options.signal }),
        client.session.inbox.list({ sessionID: binding.nativeThreadId }, { signal: this.options.signal }),
        this.options.reader.readPage({ threadId: identity.threadId, cursor: null }),
      ]);
      session = freshSession;
      this.sessions.set(binding.nativeThreadId, session);
      const latest = stored?.thread.turns.at(-1);
      if (latest) {
        execution.turn = {
          threadId: identity.threadId,
          turnId: WorkbenchTurnIdSchema.parse(latest.id),
        };
      }
      execution.active = Boolean(latest && (
          inbox.some(isManagedWorkbenchPrompt)
          || latest.status === "inProgress" && session.outcome === undefined
        ));
    }
    const activeTurn = execution.active ? execution.turn : null;
    const delivery = input.intent === "newTurn" || !activeTurn ? "queue" : "steer";
    const request = prompt(input.input);
    const messageId = nativeMessageId(input.clientMessageId);
    const itemId = WorkbenchItemIdSchema.parse(randomUUID());
    const metadata = {
      workbench: {
        version: 1 as const,
        delivery,
        itemId,
        clientMessageId: input.clientMessageId,
        input: input.input,
      },
    };
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : undefined;
    // After reload there may be no captured workflow context. Keep the session's installed
    // instructions for hidden continuation instead of replacing them with an empty workflow.
    if (!continuation || input.context) await this.options.managed.refresh({
      sessionID: binding.nativeThreadId,
      cwd: session.location.directory,
      projectId: identity.projectId,
      threadId: identity.threadId,
      model: settings?.model ?? null,
      agentPath: settings?.agentPath ?? null,
      workflowIds: input.context?.workflowIds ?? [],
      activatedSkillPaths: input.context?.activatedSkillPaths ?? [],
    });
    if (continuation && !continuation()) throw supersededContinuation;
    if (continuation && input.context) {
      const fresh = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
      if (!continuation() || !fresh || fresh.entryKind === "draft"
        || !this.options.recovery.shouldContinue(fresh.lifecycle, false)) throw supersededContinuation;
    }
    let resolvePromptOwner!: (owner: { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null) => void;
    const promptOwner = new Promise<{ threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null>(resolve => {
      resolvePromptOwner = resolve;
    });
    let providerRequest: ReturnType<WorkbenchOpenCodeClient["session"]["prompt"]>;
    const admittedSteer = activeTurn && delivery === "steer"
      ? this.createPendingSteer(
        binding.nativeThreadId,
        identity.threadId,
        activeTurn.turnId,
        itemId,
        input,
      )
      : null;
    try {
      if (admittedSteer) {
        await this.options.transcript.recordSteer(admittedSteer);
        providerRequest = client.session.prompt({
          sessionID: binding.nativeThreadId,
          id: messageId,
          ...request,
          delivery,
          metadata,
        }, { signal: this.options.signal });
        await providerRequest;
        resolvePromptOwner({
          threadId: identity.threadId,
          turnId: activeTurn.turnId,
        });
        return { kind: "steered", turnId: activeTurn.turnId };
      }
      const message: SessionMessageUser = {
        id: messageId,
        type: "user",
        text: request.text,
        time: { created: Date.now() },
        metadata,
      };
      const recorded = await this.options.transcript.record(session, [message], {
        id: identity.projectId,
        rootPath: identity.projectRoot,
      });
      if (!recorded.latestTurnId) {
        throw new Error("OpenCode accepted a root intent without admitting its Workbench turn.");
      }
      execution.turn = {
        threadId: recorded.threadId,
        turnId: recorded.latestTurnId,
      };
      execution.active = true;
      resolvePromptOwner({
        threadId: recorded.threadId,
        turnId: recorded.latestTurnId,
      });
      providerRequest = client.session.prompt({
        sessionID: binding.nativeThreadId,
        id: messageId,
        ...request,
        delivery,
        metadata,
      }, { signal: this.options.signal });
      this.trackPrompt(providerRequest, promptOwner, binding.nativeThreadId, messageId);
    } catch (error) {
      resolvePromptOwner(null);
      const failure = openCodeFailure("prompt", error);
      if (admittedSteer) {
        this.deletePendingSteer(admittedSteer);
        await this.options.transcript.recordSteer({
          ...admittedSteer,
          status: "failed",
          error: failure.message,
          resolvedAt: Date.now(),
        });
      }
      throw failure;
    }
    const turn = (await this.read(identity.threadId)).turns.at(-1);
    if (!turn) throw new Error("OpenCode accepted a root intent without materialising its Workbench turn.");
    return { kind: "started", turn };
  }

  async messageAgent(input: Parameters<WorkbenchProviderThreads["messageAgent"]>[0]) {
    await this.submit({
      threadId: input.threadId,
      clientMessageId: randomUUID(),
      input: [createWorkbenchTextInput(createWorkbenchAgentMessageText(input.message))],
      intent: "continue",
      context: input.context,
    });
  }

  async rename(threadId: string, title: string) {
    const { binding } = await this.native(threadId);
    await (await this.options.acquire()).session.update({ sessionID: binding.nativeThreadId, title });
    await this.sync(threadId);
  }

  async compact(threadId: string) {
    const { binding } = await this.native(threadId);
    await (await this.options.acquire()).session.compact({ sessionID: binding.nativeThreadId });
  }

  async delete(threadId: string) {
    const { binding } = await this.native(threadId);
    await (await this.options.acquire()).session.remove({ sessionID: binding.nativeThreadId });
  }

  async interrupt(threadId: string, turnId: string) {
    const { binding } = await this.native(threadId);
    await this.interruptSession(threadId, binding.nativeThreadId, WorkbenchTurnIdSchema.parse(turnId));
  }

  async materialize(threadId: string, turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    for (const turnId of turnIds) await this.demand(threadId, { mode: "exact", turnId }, false, signal);
  }

  private demand(threadId: string, target: WorkbenchProviderTranscriptReconcile["target"], refresh: boolean, signal = this.options.signal) {
    signal.throwIfAborted();
    return this.options.reconciliation.reconcile({ threadId, target, refresh }, signal);
  }

  async reconcile(input: WorkbenchProviderTranscriptReconcile, signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.options.signal]);
    signal.throwIfAborted();
    const { identity, binding } = await this.native(input.threadId);
    const target = input.target;
    const turn = target.mode === "latest" ? null : await this.options.identities.resolveTurn({
      threadId: identity.threadId,
      turnId: TurnReferenceSchema.parse(target.mode === "exact" ? target.turnId : target.beforeTurnId),
    });
    if (target.mode !== "latest" && (!turn?.native.nativeTurnId || turn.native.harness !== "opencode")) {
      throw new Error("OpenCode recovery has no matching native turn.");
    }
    const native = turn?.native ?? binding;
    const client = await this.options.acquire();
    const nativeTarget = target.mode === "latest" ? target
      : target.mode === "exact" ? { mode: "exact" as const, turnId: turn!.native.nativeTurnId! }
        : { mode: "previous" as const, beforeTurnId: turn!.native.nativeTurnId! };
    const cursor = target.mode === "previous"
      ? await this.options.readProviderCursor(identity.threadId, turn!.turnId) : undefined;
    try {
      const [session, window] = await Promise.all([
        client.session.get({ sessionID: native.nativeThreadId }, { signal }),
        new OpenCodeThreadWindowLoader(client).load(native.nativeThreadId, nativeTarget, cursor, signal),
      ]);
      signal.throwIfAborted();
      if (target.mode === "previous" && !window.messages.length) {
        await this.options.transcript.recordCursor(identity.threadId, turn!.turnId, null);
        return { turnIds: [], exhausted: true };
      }
      const successor = target.mode === "previous" ? {
        kind: "turn" as const, threadId: identity.threadId, turnId: turn!.turnId,
        nativeTurnId: turn!.native.nativeTurnId!, nativeThreadId: native.nativeThreadId,
        nativeLocation: native.nativeLocation, harnessId: "opencode",
        // Existing successor identity is only an ordering anchor, never re-recorded.
        state: "completed" as const, createdAt: 0, startedAt: null, endedAt: null, durationMs: null,
      } : undefined;
      const recorded = await this.syncSession(session, window.messages, {
        window: { ...window, latest: target.mode === "latest", gapIds: input.gapIds, successor },
      });
      return { turnIds: recorded.latestTurnId ? [recorded.latestTurnId] : [], exhausted: window.previousCursor === null };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw openCodeFailure("turn reconciliation", error);
    }
  }

  async sync(threadId: string, signal?: AbortSignal) {
    const { identity } = await this.native(threadId);
    const result = await this.demand(identity.threadId, { mode: "latest" }, true, signal);
    const latestTurnId = result.turnIds.at(-1);
    return { ...identity, latestTurnId: latestTurnId ? WorkbenchTurnIdSchema.parse(latestTurnId) : null, hasPendingSteers: this.pendingSteers.has(identity.threadId) };
  }

  async syncNative(nativeThreadId: string, signal?: AbortSignal) {
    const client = await this.options.acquire();
    signal?.throwIfAborted();
    const session = await client.session.get({ sessionID: nativeThreadId }, { signal });
    const identity = await this.syncSession(session, []);
    return this.sync(identity.threadId, signal);
  }

  currentTurn(nativeThreadId: string) {
    return this.executions.get(nativeThreadId)?.turn ?? null;
  }

  async startToolTranscript(
    input: Parameters<WorkbenchToolTranscript["start"]>[0],
    context: OpenCodeToolContext,
    caller: WorkbenchProviderCaller,
  ): Promise<WorkbenchToolTranscriptReference> {
    const sessionID = input.metadata.sessionID;
    if (typeof sessionID !== "string") throw new Error("OpenCode tool session is missing.");
    let active = this.currentTurn(sessionID);
    if (!active) {
      await this.syncNative(sessionID);
      active = this.currentTurn(sessionID);
    }
    if (!active || active.threadId !== caller.threadId) throw new Error("OpenCode tool has no matching admitted turn.");
    return this.options.transcript.startToolTranscript({
      ...active, sourceId: context.childID, parentId: context.parentID,
      tool: input.tool, arguments: input.arguments, startedAt: Date.now(),
    });
  }

  async finishToolTranscript(reference: WorkbenchToolTranscriptReference, result: ProviderToolResult) {
    await this.options.transcript.finishToolTranscript(reference, result);
  }

  markExecutionStarted(nativeThreadId: string) {
    this.execution(nativeThreadId).active = true;
  }

  markExecutionSettled(nativeThreadId: string) {
    this.execution(nativeThreadId).active = false;
  }

  acceptExecutionEvent(nativeThreadId: string, sequence: number) {
    const execution = this.execution(nativeThreadId);
    if (sequence <= execution.eventSequence) return false;
    execution.eventSequence = sequence;
    return true;
  }

  private execution(nativeThreadId: string) {
    let execution = this.executions.get(nativeThreadId);
    if (!execution) {
      execution = { active: false, turn: null, eventSequence: -1, intentVersion: 0, admission: null };
      this.executions.set(nativeThreadId, execution);
    }
    return execution;
  }

  async completeExecution(input: {
    sessionID: string; eventID: string; turnId: WorkbenchTurnId;
    status: "completed" | "interrupted" | "failed";
    lifecycle: WorkbenchThreadLifecycle | null;
    intentVersion?: number;
  }) {
    if (input.status !== "completed" || !this.options.recovery.shouldContinue(input.lifecycle, false)) return;
    const execution = this.execution(input.sessionID);
    const version = input.intentVersion ?? execution.intentVersion;
    const current = () => !this.options.signal.aborted && !execution.active
      && execution.turn?.turnId === input.turnId && execution.intentVersion === version
      && !this.pendingSteerSessions.has(input.sessionID) && !this.requestedInterruptions.has(input.sessionID);
    if (!current() || !execution.turn) return;
    const threadId = execution.turn.threadId;
    try {
      await this.admit(execution, async () => {
        if (!current()) return;
        const native = await this.native(threadId);
        const entry = await this.options.state.controller.getCanonicalThreadEntry(native.identity.projectId, threadId);
        if (!current() || !entry || entry.entryKind === "draft"
          || !this.options.recovery.shouldContinue(entry.lifecycle, false)) return;
        await this.submitNative({
          threadId, clientMessageId: createWorkbenchThreadRecoveryId(`opencode:${input.eventID}`),
          input: createWorkbenchUnfinishedTurnInput(), intent: "newTurn", context: execution.context,
        }, native, execution, current);
      });
    } catch (error) {
      if (error === supersededContinuation) return;
      if (this.options.signal.aborted) return;
      console.warn(`[opencode] Unfinished-turn admission failed (${error instanceof Error ? error.name : "unknown error"}).`);
      await this.options.observe({ activity: null, displayLabel: null,
        lifecycle: { threadId, event: { kind: "recoveryFailed" } } });
    }
  }

  executionIntentVersion(nativeThreadId: string) {
    return this.execution(nativeThreadId).intentVersion;
  }

  async resolveToolCaller(nativeThreadId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const identity = await this.options.identities.resolve({
      harness: "opencode",
      threadId: ThreadReferenceSchema.parse(nativeThreadId),
    });
    if (!identity) throw new Error("OpenCode MCP session is not bound to a managed Workbench thread.");
    const session = await (await this.options.acquire()).session.get({ sessionID: nativeThreadId }, { signal });
    signal.throwIfAborted();
    return { harness: "opencode" as const, threadId: identity.threadId, cwd: session.location.directory };
  }

  async settle() {
    await Promise.all([...this.executions.values()].map(execution => execution.admission));
    await Promise.allSettled(this.pendingPrompts);
  }

  consumeRequestedInterrupt(nativeThreadId: string) {
    const requested = this.requestedInterruptions.has(nativeThreadId);
    this.requestedInterruptions.delete(nativeThreadId);
    return requested;
  }

  private trackPrompt(
    request: ReturnType<WorkbenchOpenCodeClient["session"]["prompt"]>,
    owner: Promise<{ threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null>,
    nativeThreadId: string,
    messageId: string,
  ) {
    const tracked = Promise.all([
      request.then(() => true, () => false),
      owner,
    ]).then(async ([succeeded, resolvedOwner]) => {
      if (succeeded || !resolvedOwner || this.options.signal.aborted) return;
      const inbox = await (await this.options.acquire()).session.inbox.list(
        { sessionID: nativeThreadId },
        { signal: this.options.signal },
      );
      if (inbox.some(item => item.id === messageId)) return;
      const execution = this.execution(nativeThreadId);
      if (execution.turn?.turnId === resolvedOwner.turnId) execution.active = false;
      await this.options.observe({
        activity: null,
        lifecycle: {
          threadId: resolvedOwner.threadId,
          event: { kind: "turnCompleted", turnId: resolvedOwner.turnId, status: "failed" },
        },
        displayLabel: null,
      });
    }).catch(error => {
      console.error(`[opencode] prompt failure reconciliation failed: ${
        error instanceof Error ? error.message.slice(0, 500) : "unknown failure"
      }`);
    }).finally(() => {
      this.pendingPrompts.delete(tracked);
    });
    this.pendingPrompts.add(tracked);
  }

  private async syncSession(
    session: SessionInfo,
    messages: SessionMessageInfo[],
    options: Parameters<OpenCodeTranscriptAdapter["record"]>[3] = {},
  ) {
    const execution = this.execution(session.id);
    const startingTurn = execution.turn;
    const startingIntent = execution.intentVersion;
    this.sessions.set(session.id, session);
    const retained = this.options.identities.findNativeThread({
      harness: "opencode",
      nativeLocation: session.location.directory,
      nativeThreadId: NativeThreadIdSchema.parse(session.id),
    });
    const resolution = retained
      ? { project: { id: retained.projectId, rootPath: retained.projectRoot } }
      : await this.options.projects.resolveAgentEndpointProjectFromCwd(
        session.location.directory, { endpointName: "OpenCode provider history" },
      );
    const latest = options.window?.latest !== false;
    const result = await this.options.transcript.record(session, messages, {
      id: resolution.project.id,
      rootPath: resolution.project.rootPath,
    }, {
      keepLatestTurnOpen: latest && this.pendingSteerSessions.has(session.id),
      settleUsage: latest && Boolean(options.window),
      ...options,
    });
    if (!latest || !options.window) return { ...result, hasPendingSteers: this.pendingSteerSessions.has(session.id) };
    for (const clientMessageId of result.deliveredSteerClientMessageIds ?? []) {
      this.pendingSteers.get(result.threadId)?.delete(clientMessageId);
      this.deletePendingSteerSession(clientMessageId);
    }
    if (!this.pendingSteers.get(result.threadId)?.size) this.pendingSteers.delete(result.threadId);
    if (execution.turn !== startingTurn || execution.intentVersion !== startingIntent
      || execution.active && execution.turn && result.latestTurnId !== execution.turn.turnId) {
      return { ...result, hasPendingSteers: this.pendingSteerSessions.has(session.id) };
    }
    if (result.latestTurnId) {
      execution.turn = { threadId: result.threadId, turnId: result.latestTurnId };
      execution.active = result.latestTurnState === "inProgress" || this.pendingSteerSessions.has(session.id);
    } else {
      this.execution(session.id).active = false;
    }
    return { ...result, hasPendingSteers: this.pendingSteerSessions.has(session.id) };
  }

  private createPendingSteer(
    nativeThreadId: string,
    threadId: WorkbenchThreadId,
    turnId: WorkbenchTurnId,
    itemId: ReturnType<typeof WorkbenchItemIdSchema.parse>,
    input: Parameters<WorkbenchProviderThreads["submit"]>[0],
  ): OpenCodeSteerEntry {
    const entry: OpenCodeSteerEntry = {
      threadId,
      turnId,
      itemId,
      entryKey: itemId,
      input: steerInput(input.input),
      status: "pending",
      attemptedAt: Date.now(),
      resolvedAt: null,
      requestId: null,
      canonicalItemId: null,
      clientUserMessageId: input.clientMessageId,
      dispatchSequence: null,
      error: null,
    };
    const entries = this.pendingSteers.get(threadId) ?? new Map<string, WorkbenchSteerHistoryEntry>();
    entries.set(input.clientMessageId, entry);
    this.pendingSteers.set(threadId, entries);
    const sessionEntries = this.pendingSteerSessions.get(nativeThreadId) ?? new Set<string>();
    sessionEntries.add(input.clientMessageId);
    this.pendingSteerSessions.set(nativeThreadId, sessionEntries);
    return entry;
  }

  private deletePendingSteer(entry: WorkbenchSteerHistoryEntry) {
    const entries = this.pendingSteers.get(entry.threadId);
    entries?.delete(entry.clientUserMessageId ?? "");
    if (!entries?.size) this.pendingSteers.delete(entry.threadId);
    if (entry.clientUserMessageId) this.deletePendingSteerSession(entry.clientUserMessageId);
  }

  private deletePendingSteerSession(clientMessageId: string) {
    for (const [nativeThreadId, entries] of this.pendingSteerSessions) {
      entries.delete(clientMessageId);
      if (!entries.size) this.pendingSteerSessions.delete(nativeThreadId);
    }
  }

  private async interruptSession(
    threadId: string,
    nativeThreadId: string,
    suppliedTurnId?: WorkbenchTurnId,
  ) {
    this.execution(nativeThreadId).intentVersion++;
    this.requestedInterruptions.add(nativeThreadId);
    try {
      await (await this.options.acquire()).session.interrupt({ sessionID: nativeThreadId });
    } catch (error) {
      this.requestedInterruptions.delete(nativeThreadId);
      throw error;
    }
    const synced = await this.sync(threadId);
    const turnId = suppliedTurnId ?? synced.latestTurnId;
    if (!turnId) return;
    try {
      await this.options.transcript.recordTurnState({
        threadId: synced.threadId,
        turnId,
        state: "interrupted",
        observedAt: Date.now(),
      });
    } catch (error) {
      console.warn(`[opencode] interrupted turn transcript settlement failed: ${
        error instanceof Error ? error.message.slice(0, 500) : "unknown failure"
      }`);
    }
  }

  private async identity(threadId: string) {
    const identity = await this.options.identities.resolve({
      threadId: ThreadReferenceSchema.parse(threadId),
      harness: "opencode",
    });
    if (!identity) throw new Error("OpenCode thread identity is unavailable.");
    return identity;
  }

  private async native(threadId: string) {
    const identity = await this.identity(threadId);
    const binding = identity.bindings.find(candidate => candidate.harness === "opencode");
    if (!binding) throw new Error("OpenCode thread has no provider binding.");
    NativeThreadIdSchema.parse(binding.nativeThreadId);
    return { binding, identity };
  }
}

/*
 * Exports:
 * - OpenCodeThreadOperationsOptions: provider-local dependencies for native session operations.
 * - OpenCodeNativeActivity: one connection-recovery observation from native session state.
 * - default OpenCodeThreadOperations: own OpenCode thread admission, session interruption, canonical history and fenced continuation.
 */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { SessionInboxInfo, SessionInfo, SessionMessageInfo, SessionMessageUser } from "@opencode/client";
import {
  NativeThreadIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema,
  type ProjectId, type WorkbenchThreadId, type WorkbenchTurnId, WorkbenchTurnIdSchema, TurnReferenceSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads, WorkbenchProviderTranscriptReconcile } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchProviderContext } from "workbench-shared/workbench/provider/provider-context";
import type { WorkbenchProviderBrowse } from "workbench-shared/workbench/provider/provider-browse";
import type { WorkbenchThreadMessageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchTextInput, toWorkbenchThreadUserInput, WorkbenchUserInputSchema } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { collectActivatedSkillPaths } from "workbench-shared/workbench/thread/thread-skill-state";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import ProviderCompactionCompletionController from "../../ProviderCompactionCompletionController";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import OpenCodeTranscriptAdapter, {
  openCodeTokenBreakdown,
  subtractOpenCodeTokenBreakdowns,
} from "./OpenCodeTranscriptAdapter";
import type WorkbenchTranscriptReader from "../../WorkbenchTranscriptReader";
import type { WorkbenchProviderCaller, WorkbenchToolTranscript, WorkbenchToolTranscriptReference, ProviderToolResult } from "workbench-shared/workbench/provider/provider-execution";
import type { OpenCodeToolContext } from "./opencode-workbench-rpc";
import OpenCodeThreadWindowLoader from "./OpenCodeThreadWindowLoader";
import type WorkbenchTranscriptReconciliationController from "../../WorkbenchTranscriptReconciliationController";
import type WorkbenchTurnRecoveryController from "../../WorkbenchTurnRecoveryController";
import { getWorkbenchLifecycleTurnId } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchUnfinishedTurnTarget } from "workbench-shared/workbench/provider/provider-recovery";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import {
  createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput,
  isWorkbenchQuestionnaireResponsePart, WORKBENCH_THREAD_WORKING_STATUS_MESSAGE,
} from "workbench-shared/workbench/thread/thread-recovery-message";

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
  waitForCompactionConnection(signal: AbortSignal): Promise<AbortSignal>;
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
  readWorkingRecords(): Promise<Array<Pick<WorkbenchThreadStateRecord, "identity" | "lifecycle">>>;
  readProviderCursor(threadId: string, turnId: string): Promise<string | null | undefined>;
  recovery: Pick<WorkbenchTurnRecoveryController, "shouldContinue">;
}

interface SessionExecution {
  active: boolean;
  kind: "prompt" | "compaction";
  turn: { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null;
  eventSequence: number;
  intentVersion: number;
  context?: Parameters<WorkbenchProviderThreads["submit"]>[0]["context"];
  admission: Promise<void> | null;
  /** The last completed turn and the intent it ended, until continued or superseded. */
  completion?: { eventID: string; turnId: WorkbenchTurnId; intentVersion: number } | null;
  /** Persisted cumulative usage before this execution; live events derive their current-turn delta from it. */
  usageBaseline?: ThreadTokenUsage["total"];
  usageContextWindow?: number | null;
}
export interface OpenCodeNativeActivity {
  sessionID: string;
  threadId: WorkbenchThreadId;
  projectId: ProjectId;
  turn: Turn | null;
  active: boolean;
  outcome: SessionInfo["outcome"] | null;
  idleAt: number | null;
  maintenance: boolean;
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
  private readonly compactionCompletion = new ProviderCompactionCompletionController();
  hasPendingWork() {
    return this.compactionCompletion.hasPendingWork() || this.pendingCreations.size > 0 || this.pendingPrompts.size > 0 || this.pendingSteerSessions.size > 0
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

  readonly context: WorkbenchProviderContext = {
    inject: async (input, signal) => {
      signal.throwIfAborted();
      const { binding } = await this.native(input.threadId);
      const client = await this.options.acquire();
      signal.throwIfAborted();
      await client.session.instructions.entry.put({
        sessionID: binding.nativeThreadId,
        key: `workbench-context:${randomUUID()}`,
        value: input.text,
      });
      return "admitted";
    },
  };

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

  /**
   * A delivered screenshot reaches the model as the marked image steer every provider renders. Workbench records
   * Browse results itself; this only carries the image into the thread's live turn.
   */
  readonly browse: WorkbenchProviderBrowse = {
    screenshot: async input => {
      const result = await this.submit({
        threadId: WorkbenchThreadIdSchema.parse(input.threadId),
        clientMessageId: randomUUID(),
        input: [
          createWorkbenchTextInput(createAgentScreenshotSteerText()),
          { type: "image", url: input.imageUrl },
        ],
        intent: "steer",
        expectedTurnId: input.turnId,
      });
      if (result.kind !== "steered") throw new Error("OpenCode screenshot delivery needs an active turn on this thread.");
      return { kind: "steered", turnId: result.turnId };
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
    const context = { ...input.context, activatedSkillPaths: collectActivatedSkillPaths(input.input, input.context) };
    // Hidden continuation replays instruction selections only; activated skill bodies already sit in history.
    execution.context = { ...context, activatedSkillPaths: [] };
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
    const workingStatus = toWorkbenchThreadUserInput(input.input).some(isWorkbenchQuestionnaireResponsePart);
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : undefined;
    const subagentName = entry?.entryKind === "subagent" ? entry.name : null;
    // After reload there may be no captured workflow context. Keep the session's installed
    // instructions for hidden continuation instead of replacing them with an empty workflow.
    const managed = !continuation || input.context ? await this.options.managed.refresh({
      sessionID: binding.nativeThreadId,
      cwd: session.location.directory,
      projectId: identity.projectId,
      threadId: identity.threadId,
      model: settings?.model ?? null,
      agentPath: settings?.agentPath ?? null,
      workflowIds: input.context?.workflowIds ?? [],
      activatedSkillPaths: input.context?.activatedSkillPaths ?? [],
      workingStatus,
      subagentName,
    }) : null;
    const nativePrompt = prompt(input.input);
    // Display reads metadata input, so the hidden skill block reaches only the model.
    const skillText = managed?.activatedSkills
      ? createWorkbenchActivatedSkillsInput(managed.activatedSkills).text : null;
    const promptText = skillText ? [nativePrompt.text, skillText].filter(Boolean).join("\n\n") : nativePrompt.text;
    const request = {
      ...nativePrompt,
      text: workingStatus ? `${WORKBENCH_THREAD_WORKING_STATUS_MESSAGE}\n\n${promptText}` : promptText,
    };
    const messageId = nativeMessageId(input.clientMessageId);
    const itemId = WorkbenchItemIdSchema.parse(randomUUID());
    const metadata = {
      workbench: {
        version: 1 as const,
        delivery,
        ...(delivery === "steer" && activeTurn ? { turnId: activeTurn.turnId } : {}),
        itemId,
        clientMessageId: input.clientMessageId,
        input: input.input,
      },
    };
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
      execution.kind = "prompt";
      execution.usageBaseline = openCodeTokenBreakdown(session.tokens);
      execution.usageContextWindow = undefined;
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
    try {
      if (entry && entry.entryKind !== "draft" && entry.profile) {
        await this.options.state.controller.recordAcceptedSelection(entry.profile, Date.now());
      }
      return { kind: "started", turn };
    } catch (error) {
      const warning = `Turn accepted, but model/profile recency could not be saved: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"
      }`;
      console.warn("[opencode]", warning);
      return { kind: "started", turn, warning };
    }
  }

  async messageAgent(input: Parameters<WorkbenchProviderThreads["messageAgent"]>[0]) {
    const result = await this.submit({
      threadId: input.threadId,
      clientMessageId: randomUUID(),
      input: [createWorkbenchTextInput(createWorkbenchAgentMessageText(input.message))],
      intent: "continue",
      context: input.context,
    });
    return { kind: result.kind, turnId: result.kind === "started" ? result.turn.id : result.turnId };
  }

  async rename(threadId: string, title: string) {
    const { binding } = await this.native(threadId);
    await (await this.options.acquire()).session.update({ sessionID: binding.nativeThreadId, title });
    await this.sync(threadId);
  }

  async compact(threadId: string, options?: { waitForCompletion?: boolean; signal?: AbortSignal }) {
    const { binding } = await this.native(threadId);
    const client = await this.options.acquire();
    if (!options?.waitForCompletion) {
      await client.session.compact({ sessionID: binding.nativeThreadId });
      return;
    }
    const callerSignal = options.signal ? AbortSignal.any([options.signal, this.options.signal]) : this.options.signal;
    const connectionSignal = await this.options.waitForCompactionConnection(callerSignal);
    const signal = AbortSignal.any([callerSignal, connectionSignal]);
    signal.throwIfAborted();
    const active = await client.session.active({ signal });
    if (active[binding.nativeThreadId]) throw new Error("OpenCode cannot auto-compact during an active execution.");
    await this.compactionCompletion.run(binding.nativeThreadId, signal, async () => {
      await client.session.compact({ sessionID: binding.nativeThreadId }, { signal });
    });
  }

  observeCompaction(sessionID: string, phase: "started" | "completed" | "failed", reference?: string) {
    if (phase === "started") this.compactionCompletion.started(sessionID, reference ?? sessionID);
    else if (phase === "completed") this.compactionCompletion.completed(sessionID);
    else this.compactionCompletion.failed(sessionID, new Error("OpenCode compaction failed."));
  }

  async delete(threadId: string) {
    const { binding } = await this.native(threadId);
    await (await this.options.acquire()).session.remove({ sessionID: binding.nativeThreadId });
  }

  async interrupt(threadId: string) {
    const { binding } = await this.native(threadId);
    await this.interruptSession(threadId, binding.nativeThreadId);
  }

  /** The shared OpenCode service can outlive the daemon; its active sessions are the runtime truth. */
  async isTurnLive(threadId: string, _turnId: string) {
    const { binding } = await this.native(threadId);
    const active = await (await this.options.acquire()).session.active({ signal: this.options.signal });
    return Boolean(active[binding.nativeThreadId]);
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
    const execution = this.execution(native.nativeThreadId);
    const intentVersion = execution.intentVersion;
    const client = await this.options.acquire();
    const nativeTarget = target.mode === "latest" ? target
      : target.mode === "exact" ? { mode: "exact" as const, turnId: turn!.native.nativeTurnId! }
        : { mode: "previous" as const, beforeTurnId: turn!.native.nativeTurnId! };
    const cursor = target.mode === "previous"
      ? await this.options.readProviderCursor(identity.threadId, turn!.turnId) : undefined;
    try {
      const eventSequence = execution.eventSequence;
      const [session, window, active] = await Promise.all([
        client.session.get({ sessionID: native.nativeThreadId }, { signal }),
        new OpenCodeThreadWindowLoader(client).load(native.nativeThreadId, nativeTarget, cursor, signal),
        target.mode === "latest" ? client.session.active({ signal }) : Promise.resolve({}),
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
        canCommit: () => execution.intentVersion === intentVersion && execution.eventSequence === eventSequence,
        keepLatestTurnOpen: target.mode === "latest" && Boolean(active[native.nativeThreadId]),
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
    const execution = this.execution(nativeThreadId);
    if (execution.active && execution.usageBaseline === undefined) {
      execution.usageBaseline = openCodeTokenBreakdown(session.tokens);
    }
    const identity = await this.syncSession(session, []);
    const result = await this.sync(identity.threadId, signal);
    const thread = await this.read(identity.threadId);
    const turn = thread.turns.at(-1) ?? null;
    if (execution.active) {
      if (execution.usageBaseline === undefined && thread.tokenUsage) {
        execution.usageBaseline = subtractOpenCodeTokenBreakdowns(
          thread.tokenUsage.total,
          thread.tokenUsage.last,
        );
      }
      if (execution.usageContextWindow === undefined) {
        execution.usageContextWindow = thread.tokenUsage?.modelContextWindow ?? null;
      }
    }
    return {
      ...result, turn, maintenance: this.execution(nativeThreadId).kind === "compaction",
      outcome: session.outcome ?? null, idleAt: session.time.idle ?? null,
    };
  }

  async reconcileActivity(signal: AbortSignal, wasTouched: (sessionID: string) => boolean): Promise<OpenCodeNativeActivity[]> {
    signal.throwIfAborted();
    const client = await this.options.acquire();
    const active = await client.session.active({ signal });
    const durableWorking = new Map<string, WorkbenchTurnId>();
    for (const record of await this.options.readWorkingRecords()) {
      signal.throwIfAborted();
      const turnId = getWorkbenchLifecycleTurnId(record.lifecycle);
      if (!turnId) continue;
      const { binding } = await this.native(record.identity.threadId);
      durableWorking.set(binding.nativeThreadId, turnId);
    }
    const candidates = new Set([
      ...Object.keys(active),
      ...[...this.executions].filter(([sessionID, execution]) => execution.active
        || execution.admission !== null || this.pendingSteerSessions.has(sessionID)).map(([sessionID]) => sessionID),
      ...durableWorking.keys(),
    ]);
    const observations: OpenCodeNativeActivity[] = [];
    for (const sessionID of candidates) {
      signal.throwIfAborted();
      if (wasTouched(sessionID)) continue;
      if (!this.executions.has(sessionID) && !this.sessions.has(sessionID)) {
        const session = await client.session.get({ sessionID }, { signal });
        const admitted = this.options.identities.findNativeThread({
          harness: "opencode",
          nativeLocation: session.location.directory,
          nativeThreadId: NativeThreadIdSchema.parse(sessionID),
        });
        if (!admitted || wasTouched(sessionID)) continue;
      }
      const nativeActive = Boolean(active[sessionID]);
      const identity = await this.syncNative(sessionID, signal);
      if (wasTouched(sessionID)) continue;
      const turn = (await this.read(identity.threadId)).turns.at(-1) ?? null;
      if (wasTouched(sessionID)) continue;
      const durableTurnId = durableWorking.get(sessionID);
      if (!nativeActive && durableTurnId && turn?.id !== durableTurnId) continue;
      let inbox = !nativeActive ? await client.session.inbox.list({ sessionID }, { signal }) : [];
      const interruptedRoot = !nativeActive && durableTurnId === turn?.id
        && turn?.status === "interrupted" && identity.outcome === "interrupted";
      if (interruptedRoot && durableTurnId && inbox.length) {
        inbox = await this.retireInterruptedRoot(
          client, sessionID, identity.threadId, durableTurnId, inbox, signal, wasTouched,
        );
      }
      if (wasTouched(sessionID)) continue;
      const pending = !nativeActive && (this.execution(sessionID).admission !== null
        || this.pendingSteerSessions.has(sessionID) || inbox.some(isManagedWorkbenchPrompt));
      if (pending || wasTouched(sessionID)) continue;
      if (interruptedRoot && Boolean((await client.session.active({ signal }))[sessionID])) continue;
      observations.push({
        sessionID, threadId: identity.threadId, projectId: identity.projectId, turn,
        active: nativeActive && turn?.status === "inProgress",
        outcome: identity.outcome, idleAt: identity.idleAt,
        maintenance: identity.maintenance && !interruptedRoot,
      });
    }
    return observations;
  }

  private async retireInterruptedRoot(
    client: WorkbenchOpenCodeClient,
    sessionID: string,
    threadId: WorkbenchThreadId,
    turnId: WorkbenchTurnId,
    inbox: SessionInboxInfo[],
    signal: AbortSignal,
    wasTouched: (sessionID: string) => boolean,
  ) {
    const identity = await this.options.identities.resolveTurn({
      threadId, turnId: TurnReferenceSchema.parse(turnId),
    });
    const nativeTurnId = identity?.native.nativeTurnId;
    if (!nativeTurnId || identity.native.nativeThreadId !== sessionID) return inbox;
    const queued = inbox.find(item => item.id === nativeTurnId
      && item.delivery === "queue" && isManagedWorkbenchPrompt(item));
    if (!queued) return inbox;
    signal.throwIfAborted();
    if (wasTouched(sessionID)) return inbox;
    await client.session.inbox.cancel({ sessionID, inboxID: queued.id }, { signal });
    return await client.session.inbox.list({ sessionID }, { signal });
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
    const execution = this.execution(nativeThreadId);
    if (!execution.active) {
      execution.usageBaseline = this.sessions.has(nativeThreadId)
        ? openCodeTokenBreakdown(this.sessions.get(nativeThreadId)!.tokens)
        : undefined;
      execution.usageContextWindow = undefined;
    }
    execution.active = true;
  }

  markExecutionSettled(nativeThreadId: string, status: "completed" | "interrupted" | "failed" = "completed") {
    this.execution(nativeThreadId).active = false;
    if (status === "completed") this.compactionCompletion.settled(nativeThreadId);
    else this.compactionCompletion.failed(nativeThreadId, new Error("OpenCode compaction was interrupted or failed."));
  }

  async recordUsage(
    nativeThreadId: string,
    tokens: SessionInfo["tokens"],
    _observedAt: number,
  ): Promise<{ threadId: WorkbenchThreadId; turnId: WorkbenchTurnId; tokenUsage: ThreadTokenUsage } | null> {
    const execution = this.execution(nativeThreadId);
    const active = execution.active && execution.kind === "prompt" ? execution.turn : null;
    if (!active) return null;
    const intentVersion = execution.intentVersion;
    const isCurrent = () => this.execution(nativeThreadId) === execution
      && execution.active && execution.kind === "prompt"
      && execution.turn?.turnId === active.turnId && execution.intentVersion === intentVersion;
    let session = this.sessions.get(nativeThreadId);
    if (!session) {
      session = await (await this.options.acquire()).session.get({
        sessionID: nativeThreadId,
      }, { signal: this.options.signal });
      this.sessions.set(nativeThreadId, session);
    }
    if (!isCurrent()) return null;
    if (execution.usageBaseline === undefined || execution.usageContextWindow === undefined) {
      const thread = await this.read(active.threadId);
      if (!isCurrent()) return null;
      execution.usageBaseline ??= thread.tokenUsage?.total ?? {
        cacheWriteInputTokens: 0,
        cachedInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      };
      execution.usageContextWindow = thread.tokenUsage?.modelContextWindow ?? null;
    }
    const tokenUsage = await this.options.transcript.recordContextUsage({
      threadId: active.threadId,
      baseline: execution.usageBaseline,
      current: tokens,
      model: session.model ?? null,
      nativeLocation: session.location.directory,
      modelContextWindow: execution.usageContextWindow ?? null,
      canCommit: isCurrent,
    });
    return tokenUsage && isCurrent() ? { ...active, tokenUsage } : null;
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
      execution = { active: false, kind: "prompt", turn: null, eventSequence: -1, intentVersion: 0, admission: null };
      this.executions.set(nativeThreadId, execution);
    }
    return execution;
  }

  /** Fence a completed execution so Workbench core's later continuation request knows which intent it ended. */
  settleExecution(input: {
    sessionID: string; eventID: string; turnId: WorkbenchTurnId;
    status: "completed" | "interrupted" | "failed";
    intentVersion?: number;
  }) {
    const execution = this.execution(input.sessionID);
    execution.completion = input.status === "completed" ? {
      eventID: input.eventID, turnId: input.turnId, intentVersion: input.intentVersion ?? execution.intentVersion,
    } : null;
  }

  /** Admit the hidden unfinished-turn prompt once, unless newer intent, steers or interruption superseded the turn. */
  async continueUnfinished(target: WorkbenchUnfinishedTurnTarget) {
    if (this.options.signal.aborted) return;
    const { binding } = await this.native(target.threadId);
    const sessionID = binding.nativeThreadId;
    const execution = this.execution(sessionID);
    const completion = execution.completion;
    if (!completion || completion.turnId !== target.turnId) return;
    execution.completion = null;
    const current = () => !this.options.signal.aborted && !execution.active
      && execution.turn?.turnId === completion.turnId && execution.intentVersion === completion.intentVersion
      && !this.pendingSteerSessions.has(sessionID) && !this.requestedInterruptions.has(sessionID);
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
          threadId, clientMessageId: createWorkbenchThreadRecoveryId(`opencode:${completion.eventID}`),
          input: createWorkbenchUnfinishedTurnInput(), intent: "newTurn", context: execution.context,
        }, native, execution, current);
      });
    } catch (error) {
      if (error === supersededContinuation || this.options.signal.aborted) return;
      // Native admission errors can carry session content; only their class crosses this edge.
      throw new Error(`OpenCode unfinished-turn admission failed (${error instanceof Error ? error.name : "unknown error"}).`);
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
        turnStarted: null,
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
    const canCommit = (latestTurnId: WorkbenchTurnId | null) => options.canCommit?.(latestTurnId) !== false
      && execution.turn === startingTurn && execution.intentVersion === startingIntent
      && !(latest && execution.active && execution.turn && latestTurnId !== execution.turn.turnId);
    const result = await this.options.transcript.record(session, messages, {
      id: resolution.project.id,
      rootPath: resolution.project.rootPath,
    }, {
      keepLatestTurnOpen: latest && this.pendingSteerSessions.has(session.id),
      settleUsage: latest && Boolean(options.window),
      ...options,
      ...(options.window ? { canCommit } : {}),
    });
    if (!latest || !options.window || !canCommit(result.latestTurnId)) {
      return { ...result, hasPendingSteers: this.pendingSteerSessions.has(session.id) };
    }
    for (const clientMessageId of result.deliveredSteerClientMessageIds ?? []) {
      this.pendingSteers.get(result.threadId)?.delete(clientMessageId);
      this.deletePendingSteerSession(clientMessageId);
    }
    if (!this.pendingSteers.get(result.threadId)?.size) this.pendingSteers.delete(result.threadId);
    if (result.latestTurnId) {
      execution.turn = { threadId: result.threadId, turnId: result.latestTurnId };
      execution.active = result.latestTurnState === "inProgress" || this.pendingSteerSessions.has(session.id);
      execution.kind = result.latestOperation ?? "prompt";
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
  ) {
    const execution = this.execution(nativeThreadId);
    const interruptedTurnId = execution.active ? execution.turn?.turnId : undefined;
    let intentVersion = ++execution.intentVersion;
    this.requestedInterruptions.add(nativeThreadId);
    let client: WorkbenchOpenCodeClient;
    try {
      client = await this.options.acquire();
      await client.session.interrupt({ sessionID: nativeThreadId });
    } catch (error) {
      this.requestedInterruptions.delete(nativeThreadId);
      throw error;
    }
    if (execution.intentVersion === intentVersion) intentVersion = ++execution.intentVersion;
    const synced = await this.sync(threadId);
    const turnId = interruptedTurnId ?? synced.latestTurnId;
    if (!turnId) return;
    if (execution.intentVersion === intentVersion && execution.turn?.turnId === turnId) {
      execution.active = false;
    }
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
    await this.retireStoppedInbox(client, nativeThreadId, synced.threadId, turnId);
    const [active, inbox] = await Promise.all([
      client.session.active({ signal: this.options.signal }),
      client.session.inbox.list({ sessionID: nativeThreadId }, { signal: this.options.signal }),
    ]);
    if (execution.intentVersion !== intentVersion || active[nativeThreadId]
      || inbox.some(isManagedWorkbenchPrompt)) return;
    await this.options.observe({
      projectId: synced.projectId,
      turnStarted: null,
      displayLabel: null,
      lifecycle: { threadId: synced.threadId, event: { kind: "turnCompleted", turnId, status: "interrupted" } },
    });
  }

  private async retireStoppedInbox(
    client: WorkbenchOpenCodeClient,
    sessionID: string,
    threadId: WorkbenchThreadId,
    turnId: WorkbenchTurnId,
  ) {
    const inbox = await client.session.inbox.list({ sessionID }, { signal: this.options.signal });
    const turn = await this.options.identities.resolveTurn({
      threadId, turnId: TurnReferenceSchema.parse(turnId),
    });
    const nativeTurnId = turn?.native.nativeThreadId === sessionID ? turn.native.nativeTurnId : null;
    for (const item of inbox) {
      if (!isManagedWorkbenchPrompt(item)) continue;
      if (item.id === nativeTurnId) {
        await client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal: this.options.signal });
        continue;
      }
      if (item.type !== "user" || item.delivery !== "steer") continue;
      const workbench = item.payload.metadata?.workbench;
      if (!workbench || typeof workbench !== "object" || Array.isArray(workbench)) continue;
      const clientMessageId = typeof workbench.clientMessageId === "string" ? workbench.clientMessageId : null;
      const pending = clientMessageId ? this.pendingSteers.get(threadId)?.get(clientMessageId) : null;
      if (workbench.turnId !== turnId && pending?.turnId !== turnId) continue;
      const itemId = WorkbenchItemIdSchema.safeParse(workbench.itemId);
      const input = WorkbenchUserInputSchema.array().safeParse(workbench.input);
      if (!pending && (!itemId.success || !input.success || !clientMessageId)) {
        throw new Error("OpenCode managed steer metadata is incomplete for stop.");
      }
      await client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal: this.options.signal });
      if (pending) {
        await this.options.transcript.recordSteer({
          ...pending, threadId, turnId, status: "interrupted", resolvedAt: Date.now(),
        });
        this.deletePendingSteer(pending);
      } else if (itemId.success && input.success && clientMessageId) {
        await this.options.transcript.recordSteer({
          threadId, turnId, itemId: itemId.data, entryKey: itemId.data,
          input: steerInput(input.data), status: "interrupted",
          attemptedAt: item.time.created, resolvedAt: Date.now(),
          requestId: null, canonicalItemId: null, clientUserMessageId: clientMessageId,
          dispatchSequence: null, error: null,
        });
      }
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

/*
 * Exports:
 * - OpenCodeThreadOperationsOptions: provider-local dependencies for native session operations.
 * - default OpenCodeThreadOperations: translate WB thread intent to the pinned OpenCode client and canonical SQL history.
 */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { SessionInfo, SessionMessageInfo, SessionMessageUser } from "@opencode/client";
import {
  NativeThreadIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema, WorkbenchThreadIdSchema,
  type WorkbenchThreadId, type WorkbenchTurnId, WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderObservation } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchThreadMessageResult } from "workbench-shared/workbench/thread/thread-actions";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchTextInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type OpenCodeManagedSessionController from "./OpenCodeManagedSessionController";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import OpenCodeTranscriptAdapter from "./OpenCodeTranscriptAdapter";
import OpenCodeTranscriptReader from "./OpenCodeTranscriptReader";

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
  projects: Pick<WorkbenchProjectCatalogController, "resolveAgentEndpointProjectFromCwd">;
  questionnaires: Pick<
    WorkbenchQuestionnaireController,
    "canDeliver" | "deliver" | "interruptRetainingQuestionnaire"
  >;
  state: Pick<WorkbenchThreadStateFeature, "controller" | "installCreatedProfile">;
  managed: Pick<OpenCodeManagedSessionController, "creation" | "refresh">;
  transcript: OpenCodeTranscriptAdapter;
  reader: OpenCodeTranscriptReader;
  signal: AbortSignal;
}

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

async function listMessages(
  client: WorkbenchOpenCodeClient,
  sessionID: string,
  signal?: AbortSignal,
) {
  const messages: SessionMessageInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await client.message.list(
      { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) },
      { signal },
    );
    messages.push(...page.data);
    const next = page.cursor.next ?? undefined;
    if (next && cursors.has(next)) throw new Error("OpenCode message pagination repeated a cursor.");
    if (next) cursors.add(next);
    cursor = next;
  } while (cursor);
  return messages;
}

export default class OpenCodeThreadOperations implements WorkbenchProviderThreads {
  private readonly pendingPrompts = new Set<Promise<void>>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly latestTurns = new Map<string, {
    threadId: Awaited<ReturnType<OpenCodeTranscriptAdapter["record"]>>["threadId"];
    turnId: NonNullable<Awaited<ReturnType<OpenCodeTranscriptAdapter["record"]>>["latestTurnId"]>;
  }>();
  private readonly pendingSteers = new Map<string, Map<string, WorkbenchSteerHistoryEntry>>();
  private readonly pendingSteerSessions = new Map<string, Set<string>>();
  private readonly requestedInterruptions = new Set<string>();

  readonly history = {
    materialize: async (threadId: string, _turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      await this.sync(threadId, signal);
    },
    questionnaires: async () => [],
    steers: async threadId => [...(this.pendingSteers.get(threadId)?.values() ?? [])],
    browse: async () => [],
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
    record: async () => ({}),
  };

  async create(input: Parameters<WorkbenchProviderThreads["create"]>[0]) {
    const client = await this.options.acquire();
    const project = (await this.options.projects.resolveAgentEndpointProjectFromCwd(
      input.cwd, { endpointName: "OpenCode provider thread admission" },
    )).project;
    const settings = input.profile.settings;
    const session = await client.session.create({
      location: { directory: input.cwd },
      ...(settings.model ? { model: modelRef(settings.model) } : {}),
      ...this.options.managed.creation(),
    });
    this.sessions.set(session.id, session);
    const identity = await this.options.transcript.record(session, [], { id: project.id, rootPath: project.rootPath });
    const thread = (await this.page({ threadId: identity.threadId, cursor: null })).thread;
    await this.options.state.installCreatedProfile("opencode", thread, input.profile);
    return thread;
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
      const identity = await this.syncSession(session);
      const page = await this.options.reader.readPage({ threadId: identity.threadId, cursor: null }, null);
      if (page) data.push(page.thread);
    }
    return { data, nextCursor: response.cursor.next ?? null };
  }

  async read(threadId: string) {
    return (await this.page({ threadId, cursor: null })).thread;
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

  async page(input: Parameters<WorkbenchProviderThreads["page"]>[0]) {
    const identity = await this.identity(input.threadId);
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    const page = await this.options.reader.readPage({ ...input, threadId: identity.threadId }, entry);
    if (page) return page;
    await this.sync(identity.threadId);
    const materialized = await this.options.reader.readPage({ ...input, threadId: identity.threadId }, entry);
    if (!materialized) throw new Error("OpenCode transcript did not settle after canonical session materialisation.");
    return materialized;
  }

  async submit(input: Parameters<WorkbenchProviderThreads["submit"]>[0]): Promise<WorkbenchThreadMessageResult> {
    const { binding, identity } = await this.native(input.threadId);
    const client = await this.options.acquire();
    const delivery = input.intent === "steer" ? "steer" : "queue";
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
    const session = input.intent === "steer" ? null : this.sessions.get(binding.nativeThreadId)
      ?? await client.session.get({ sessionID: binding.nativeThreadId }, { signal: this.options.signal });
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : undefined;
    await this.options.managed.refresh({
      sessionID: binding.nativeThreadId,
      cwd: session?.location.directory ?? identity.projectRoot,
      projectId: identity.projectId,
      threadId: identity.threadId,
      model: settings?.model ?? null,
      agentPath: settings?.agentPath ?? null,
      workflowIds: input.context?.workflowIds ?? [],
      activatedSkillPaths: input.input.flatMap(part => part.type === "skill" ? [part.path] : []),
    });
    let resolvePromptOwner!: (owner: { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null) => void;
    const promptOwner = new Promise<{ threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null>(resolve => {
      resolvePromptOwner = resolve;
    });
    let providerRequest: ReturnType<WorkbenchOpenCodeClient["session"]["prompt"]>;
    const admittedSteer = input.intent === "steer"
      ? this.createPendingSteer(
        binding.nativeThreadId,
        identity.threadId,
        WorkbenchTurnIdSchema.parse(input.expectedTurnId),
        itemId,
        input,
      )
      : null;
    try {
      if (admittedSteer) await this.options.transcript.recordSteer(admittedSteer);
      providerRequest = client.session.prompt({
        sessionID: binding.nativeThreadId,
        id: messageId,
        ...request,
        delivery,
        metadata,
      }, { signal: this.options.signal });
      if (input.intent === "steer") {
        await providerRequest;
        resolvePromptOwner({
          threadId: identity.threadId,
          turnId: WorkbenchTurnIdSchema.parse(input.expectedTurnId),
        });
        return { kind: "steered", turnId: input.expectedTurnId };
      }
      this.trackPrompt(providerRequest, promptOwner);
      const message: SessionMessageUser = {
        id: messageId,
        type: "user",
        text: request.text,
        time: { created: Date.now() },
        metadata,
      };
      const recorded = await this.options.transcript.record(session!, [message], {
        id: identity.projectId,
        rootPath: identity.projectRoot,
      });
      if (!recorded.latestTurnId) {
        throw new Error("OpenCode accepted a root intent without admitting its Workbench turn.");
      }
      this.latestTurns.set(binding.nativeThreadId, {
        threadId: recorded.threadId,
        turnId: recorded.latestTurnId,
      });
      resolvePromptOwner({
        threadId: recorded.threadId,
        turnId: recorded.latestTurnId,
      });
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

  async materialize(threadId: string, _turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.sync(threadId, signal);
  }

  async sync(threadId: string, signal?: AbortSignal) {
    const { binding } = await this.native(threadId);
    signal?.throwIfAborted();
    const client = await this.options.acquire();
    let session: SessionInfo;
    let messages: SessionMessageInfo[];
    try {
      [session, messages] = await Promise.all([
        client.session.get({ sessionID: binding.nativeThreadId }, { signal }),
        listMessages(client, binding.nativeThreadId, signal),
      ]);
    } catch (error) {
      throw openCodeFailure("canonical sync", error);
    }
    return this.syncSession(session, messages);
  }

  async syncNative(nativeThreadId: string, signal?: AbortSignal) {
    const client = await this.options.acquire();
    signal?.throwIfAborted();
    let session: SessionInfo;
    let messages: SessionMessageInfo[];
    try {
      [session, messages] = await Promise.all([
        client.session.get({ sessionID: nativeThreadId }, { signal }),
        listMessages(client, nativeThreadId, signal),
      ]);
    } catch (error) {
      throw openCodeFailure("canonical sync", error);
    }
    return this.syncSession(session, messages);
  }

  currentTurn(nativeThreadId: string) {
    return this.latestTurns.get(nativeThreadId) ?? null;
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
  ) {
    const tracked = Promise.all([
      request.then(() => true, () => false),
      owner,
    ]).then(async ([succeeded, resolvedOwner]) => {
      if (succeeded || !resolvedOwner || this.options.signal.aborted) return;
      await this.options.observe({
        activity: null,
        lifecycle: {
          threadId: resolvedOwner.threadId,
          event: { kind: "turnCompleted", turnId: resolvedOwner.turnId, status: "failed" },
        },
        title: null,
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

  private async syncSession(session: SessionInfo, suppliedMessages?: SessionMessageInfo[]) {
    this.sessions.set(session.id, session);
    const resolution = await this.options.projects.resolveAgentEndpointProjectFromCwd(
      session.location.directory, { endpointName: "OpenCode provider history" },
    );
    const messages = suppliedMessages ?? await listMessages(await this.options.acquire(), session.id);
    const result = await this.options.transcript.record(session, messages, {
      id: resolution.project.id,
      rootPath: resolution.project.rootPath,
    }, {
      keepLatestTurnOpen: this.pendingSteerSessions.has(session.id),
      settleUsage: true,
    });
    for (const clientMessageId of result.deliveredSteerClientMessageIds ?? []) {
      this.pendingSteers.get(result.threadId)?.delete(clientMessageId);
      this.deletePendingSteerSession(clientMessageId);
    }
    if (!this.pendingSteers.get(result.threadId)?.size) this.pendingSteers.delete(result.threadId);
    if (result.latestTurnId) {
      this.latestTurns.set(session.id, { threadId: result.threadId, turnId: result.latestTurnId });
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

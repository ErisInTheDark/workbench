/*
 * Exports:
 * - ClaudeTurnHandoff: one paused live turn's turn and transcript state for the next bridge generation.
 * - ClaudeInstructionInput: thread facts one managed Claude prompt build reads.
 * - ClaudeThreadOperationsOptions: bind host-owned Claude sessions to Workbench identity, state, lifecycle publication, and managed MCP.
 * - default ClaudeThreadOperations: admit Claude turns and steers with their activated skill bodies and pending agent context, launch them on the harness session host with their configured or model-default context window, pause and restore live turns across bridge reloads, continue unfinished turns with their launch context, attest turn liveness, hold admitted steers in canonical history, deliver Browse screenshots, hydrate billing usage from session logs, and own native session operations.
 */
import {
    deleteSession, getSessionInfo, listSessions, query, renameSession,
    type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import {
    NativeThreadIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema,
    WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
    type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchContextTrigger, WorkbenchProviderContext } from "workbench-shared/workbench/provider/provider-context";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { collectActivatedSkillPaths } from "workbench-shared/workbench/thread/thread-skill-state";
import { toWorkbenchThreadUserInput } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type {
    WorkbenchProviderObservation, WorkbenchTranscriptNotification,
} from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import {
    createWorkbenchThreadRecoveryId, createWorkbenchUnfinishedTurnInput,
    isWorkbenchQuestionnaireResponsePart,
    WORKBENCH_THREAD_WORKING_STATUS_MESSAGE,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import type { WorkbenchMessageContext } from "workbench-shared/workbench/provider/provider-input";
import type { WorkbenchUnfinishedTurnTarget } from "workbench-shared/workbench/provider/provider-recovery";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type WorkbenchTranscriptReader from "../../WorkbenchTranscriptReader";
import { createClaudeFileClaimHooks } from "./claude-file-claim-hook";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";
import {
    appendClaudePrompt, claudeImageBlock, claudePromptContent, prefixClaudePrompt, type ClaudePromptContent,
} from "./claude-prompt-content";
import type { WorkbenchProviderBrowse } from "workbench-shared/workbench/provider/provider-browse";
import { createAgentScreenshotSteerText } from "workbench-shared/workbench/thread/thread-steer-markers";
import ClaudeConfigView from "./ClaudeConfigView";
import ClaudeLiveTurn, { type ClaudeLiveTurnSnapshot } from "./ClaudeLiveTurn";
import type ClaudeSessionHost from "./ClaudeSessionHost";
import { ENDED_CLAUDE_SESSION, spawnTrackedClaude } from "./ClaudeSessionHost";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import type { ClaudeTranscriptTurnState } from "./ClaudeTranscriptAdapter";
import { CLAUDE_COMMENTARY_SERVER_NAME, createClaudeCommentaryServer } from "./claude-commentary-tool";
import ClaudeUsageHydrator from "./ClaudeUsageHydrator";

export interface ClaudeTurnHandoff {
  turn: ClaudeLiveTurnSnapshot;
  transcript: ClaudeTranscriptTurnState;
}

export interface ClaudeInstructionInput {
  cwd: string; projectId: string; threadId: string; model: string | null; agentPath: string | null;
  workflowIds: readonly string[];
  subagentName?: string | null;
}

export interface ClaudeThreadOperationsOptions {
  daemonOrigin: string;
  /** Harness-owned live processes; they outlive this bridge generation. */
  sessions: ClaudeSessionHost;
  /** Request-scoped compaction query factory; live turns launch through `sessions`. */
  createQuery?: typeof query;
  resolveExecutable?: () => string;
  identities: WorkbenchThreadIdentityController;
  projects: WorkbenchProjectCatalogController;
  questionnaires: WorkbenchQuestionnaireController;
  reader: WorkbenchTranscriptReader;
  state: WorkbenchThreadStateFeature;
  transcript: ClaudeTranscriptAdapter;
  signal: AbortSignal;
  observe(facts: WorkbenchProviderObservation): Promise<unknown>;
  broadcast(notification: WorkbenchTranscriptNotification): void;
  buildInstructions(input: ClaudeInstructionInput): Promise<string>;
  /** Filtered bodies of the skills one submission activates; null when none resolve. */
  buildActivatedSkills(input: ClaudeInstructionInput & { activatedSkillPaths: readonly string[] }): Promise<string | null>;
  /** Admit pending agent context at an input boundary; live turns receive it through `context.inject`. */
  collectInputContext(threadId: WorkbenchThreadId, trigger: WorkbenchContextTrigger, signal: AbortSignal): Promise<void>;
  /** The window a profile without a configured window launches with; null keeps Claude's own window. */
  defaultContextWindow(model: string): Promise<number | null>;
  /** Claude's real data root holding native session logs; defaults to the daemon user's root. */
  claudeDataRoot?: string;
}

export default class ClaudeThreadOperations implements WorkbenchProviderThreads {
  private readonly live = new Map<WorkbenchThreadId, ClaudeLiveTurn>();
  private readonly scopes = new Map<string, ClaudeLiveTurn>();
  /** Each thread's last completed turn and its launch context, until continued or superseded by a new turn. */
  private readonly completedTurns = new Map<WorkbenchThreadId, { turnId: WorkbenchTurnId; context: WorkbenchMessageContext | undefined }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly usageHydrator: ClaudeUsageHydrator;

  constructor(private readonly options: ClaudeThreadOperationsOptions) {
    this.usageHydrator = new ClaudeUsageHydrator({
      dataRoot: options.claudeDataRoot ?? ClaudeConfigView.dataRoot(),
      signal: options.signal,
      readThread: async threadId => {
        const identity = await this.identity(threadId);
        const binding = identity.bindings.find(value => value.harness === "claude");
        if (!binding) throw new Error("Claude thread has no native session identity.");
        const { turns } = await this.read(identity.threadId);
        return {
          threadId: identity.threadId, sessionId: binding.nativeThreadId,
          turns: turns.map(turn => ({ id: WorkbenchTurnIdSchema.parse(turn.id), startedAt: turn.startedAt })),
        };
      },
      record: (threadId, usage, observedAt) => this.options.transcript.recordTurnUsage(threadId, usage.turnId, {
        model: usage.model, mixedModels: usage.mixedModels, cumulative: usage.cumulative, observedAt,
      }),
      warn: message => { console.warn(message.slice(0, 500)); },
    });
  }

  hasPendingWork() { return this.pending.size > 0 || this.live.size > 0 || this.usageHydrator.hasPendingWork(); }

  /** Harness restart or daemon shutdown: interrupt every live turn and publish its settlement. */
  async interruptAll() {
    await Promise.all([...this.live.values()].map(runtime => this.interrupt(runtime.threadId, runtime.turnId)));
    await Promise.all(this.pending);
  }

  /** Stop live turns at a message boundary; their processes keep running for the next bridge generation. */
  async pause(): Promise<ClaudeTurnHandoff[]> {
    const turns = [...this.live.values()];
    await Promise.all(turns.map(turn => turn.pause()));
    return turns.flatMap(turn => {
      const snapshot = turn.snapshot();
      const transcript = snapshot && this.options.transcript.captureTurn(snapshot.turnId);
      if (snapshot && !transcript) console.error("[claude] paused turn has no transcript scope", snapshot.turnId);
      return snapshot && transcript ? [{ turn: snapshot, transcript }] : [];
    });
  }

  /** Rollback after pause(): this generation keeps reading its own turns. */
  resume() {
    for (const turn of this.live.values()) this.track(turn.continue());
  }

  /** Continue turns a previous bridge generation paused, over the sessions the harness kept alive. */
  adopt(handoffs: readonly ClaudeTurnHandoff[]) {
    for (const { turn: snapshot, transcript } of handoffs) {
      this.options.transcript.restoreTurn(transcript);
      const session = this.options.sessions.get(snapshot.scope);
      if (!session) console.error("[claude] live turn lost its process across reload", snapshot.turnId);
      const live = ClaudeLiveTurn.restore(snapshot, {
        session: session ?? ENDED_CLAUDE_SESSION,
        ...this.collaborators(snapshot.threadId, snapshot.turnId, snapshot.scope, snapshot.context),
      });
      this.live.set(snapshot.threadId, live);
      this.scopes.set(snapshot.scope, live);
      this.track(live.continue());
    }
  }

  /** Bridge retirement: release this generation without interrupting turns the harness still owns. */
  async dispose() {
    await this.pause();
    await Promise.all(this.pending);
    await this.usageHydrator.settle();
  }

  private collaborators(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, scope: string, context: WorkbenchMessageContext | undefined) {
    return {
      transcript: this.options.transcript,
      usageChanged: () => this.refreshUsage(threadId),
      observe: this.options.observe,
      broadcast: this.options.broadcast,
      readTurn: async () => (await this.read(threadId)).turns.find(turn => turn.id === turnId) ?? null,
      release: async () => {
        if (this.live.get(threadId)?.turnId === turnId) this.live.delete(threadId);
        if (this.scopes.get(scope)?.turnId === turnId) this.scopes.delete(scope);
      },
      settling: (status: "completed" | "failed" | "interrupted") => {
        if (status === "completed") this.completedTurns.set(threadId, { turnId, context });
        else if (this.completedTurns.get(threadId)?.turnId === turnId) this.completedTurns.delete(threadId);
      },
    };
  }

  /** A profile without a configured window means its model's default; launching with it keeps the reported window true from the first model round. */
  private async launchContextWindow(settings: { model?: string | null; contextWindowTokens?: number | null } | null | undefined) {
    if (settings?.contextWindowTokens != null) return settings.contextWindowTokens;
    return settings?.model ? await this.options.defaultContextWindow(settings.model) : null;
  }

  private track(task: Promise<void>) {
    if (this.pending.has(task)) return;
    this.pending.add(task);
    void task.then(
      () => { this.pending.delete(task); },
      error => {
        this.pending.delete(task);
        console.error("[claude] transcript settlement failed",
          error instanceof Error ? error.message.slice(0, 500) : "unknown failure");
      },
    );
  }

  /** Billing usage comes from Claude's own session log, which survives reloads, interrupts, and compaction. */
  readonly usage = {
    hydrate: async (threadId: string) => {
      const identity = await this.identity(threadId);
      return { state: await this.usageHydrator.hydrate(identity.threadId) };
    },
  };

  private refreshUsage(threadId: WorkbenchThreadId) {
    void this.usageHydrator.hydrate(threadId).catch((error: unknown) => {
      if (this.options.signal.aborted) return;
      console.warn("[claude] session usage hydration failed",
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure");
    });
  }

  resolveScope(scope: string) {
    const runtime = this.scopes.get(scope);
    if (!runtime) throw new Error("Claude MCP client scope is not active.");
    return runtime;
  }

  readonly context: WorkbenchProviderContext = {
    inject: async (input, signal) => {
      signal.throwIfAborted();
      const identity = await this.identity(input.threadId);
      const runtime = this.live.get(identity.threadId);
      if (runtime) {
        if (input.text === WORKBENCH_THREAD_WORKING_STATUS_MESSAGE) runtime.injectWorkingStatus(input.text);
        else runtime.inject(input.text);
        return "admitted";
      }
      if (input.text === WORKBENCH_THREAD_WORKING_STATUS_MESSAGE) {
        const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        if (entry?.entryKind === "thread" && entry.lifecycle.kind === "working") return "admitted";
      }
      return "unsupported";
    },
  };

  /** Screenshots reach the model as an image in the thread's live turn. */
  readonly browse: WorkbenchProviderBrowse = {
    screenshot: async input => {
      const identity = await this.identity(input.threadId);
      const runtime = this.live.get(identity.threadId);
      if (!runtime) throw new Error("Claude screenshot delivery needs an active turn on this thread.");
      runtime.injectContent([
        { type: "text", text: createAgentScreenshotSteerText() },
        claudeImageBlock(input.imageUrl),
      ]);
      await this.options.transcript.recordScreenshotSteer(identity.threadId, runtime.turnId, input.imageUrl);
      return { kind: "injected", acceptedAt: Date.now(), turnId: runtime.turnId };
    },
  };

  readonly history = {
    materialize: async (threadId: string, _turnId: string | null, signal: AbortSignal) => {
      signal.throwIfAborted();
      await this.read(threadId);
    },
  };

  readonly interactions: WorkbenchProviderInteractions = {
    pending: async () => [],
    canDeliver: async (threadId, requestKey) => this.options.questionnaires.canDeliver(
      WorkbenchThreadIdSchema.parse(threadId), requestKey,
    ),
    deliver: async input => Boolean(await this.options.questionnaires.deliver({
      ...input, threadId: WorkbenchThreadIdSchema.parse(input.threadId),
    })),
    interruptRetaining: async (input, isCurrent) => this.options.questionnaires.interruptRetainingQuestionnaire(
      WorkbenchThreadIdSchema.parse(input.threadId), input.requestKey,
      async () => {
        if (!await isCurrent()) return false;
        const runtime = this.live.get(WorkbenchThreadIdSchema.parse(input.threadId));
        if (runtime) await this.interrupt(input.threadId, runtime.turnId);
        return isCurrent();
      },
    ),
    respond: async () => { throw new Error("Claude does not own provider-native questionnaire responses."); },
    supplement: async input => {
      await this.submit({
        threadId: input.threadId, clientMessageId: randomUUID(),
        input: input.input, intent: "steer", expectedTurnId: input.turnId,
        context: { activatedSkillPaths: input.activatedSkillPaths },
      });
    },
    record: async entry => {
      await this.options.transcript.recordQuestionnaire(entry);
      return {};
    },
  };

  async create(input: Parameters<WorkbenchProviderThreads["create"]>[0]) {
    const project = input.projectLocation
      ? await this.options.projects.resolveProjectById(input.projectLocation.id)
      : (await this.options.projects.resolveAgentEndpointProjectFromCwd(
        input.cwd, { endpointName: "Claude provider thread admission" },
      )).project;
    if (project.rootPath !== input.cwd) throw new Error("Claude creation target disagrees with its project.");
    const sessionId = randomUUID();
    const threadId = await this.options.transcript.create(sessionId, input.cwd, {
      id: project.id, rootPath: project.rootPath,
      ...(input.projectLocation?.launchId ? { launchId: input.projectLocation.launchId } : {}),
    });
    const thread = await this.read(threadId);
    await this.options.state.installCreatedProfile("claude", thread, input.profile);
    return thread;
  }

  async list(input: Parameters<WorkbenchProviderThreads["list"]>[0]) {
    const sessions = await listSessions({ dir: input.cwd, limit: input.limit ?? 50 });
    const data = [];
    for (const session of sessions) {
      const identity = await this.options.identities.resolveNative({
        harness: "claude", nativeLocation: input.cwd,
        nativeThreadId: NativeThreadIdSchema.parse(session.sessionId),
      });
      if (identity) data.push(await this.read(identity.threadId));
    }
    return { data, nextCursor: null };
  }

  async read(threadId: string) {
    const identity = await this.identity(threadId);
    const { thread } = await this.options.reader.readPage({ threadId: identity.threadId, cursor: null });
    // Live turns are this owner's runtime fact. Saved thread state can lag acceptance, and a
    // reconciliation snapshot must never report a running turn as inactive.
    return this.live.has(identity.threadId) && thread.status !== "active:waitingOnUserInput"
      ? { ...thread, status: "active" as const }
      : thread;
  }

  async readLatest(threadId: string) { return this.read(threadId); }
  async latestTurn(threadId: string) { return (await this.read(threadId)).turns.at(-1) ?? null; }
  async admitTurn(threadId: string) { await this.read(threadId); }

  async submit(input: Parameters<WorkbenchProviderThreads["submit"]>[0]) {
    this.options.signal.throwIfAborted();
    const identity = await this.identity(input.threadId);
    let runtime = this.live.get(identity.threadId);
    if (runtime && !runtime.acceptingInput) {
      await runtime.whenSettled();
      runtime = this.live.get(identity.threadId);
    }
    const content = await claudePromptContent(input.input);
    const binding = identity.bindings.find(value => value.harness === "claude");
    if (!binding) throw new Error("Claude thread has no native session identity.");
    const activatedSkillPaths = collectActivatedSkillPaths(input.input, input.context);
    if (runtime && input.intent !== "newTurn") {
      if ("expectedTurnId" in input && input.expectedTurnId && input.expectedTurnId !== runtime.turnId) {
        throw new Error("Claude steer targeted a different turn.");
      }
      const steerContent = activatedSkillPaths.length
        ? await this.withActivatedSkills(content, activatedSkillPaths, await this.instructionInput(identity, binding, input.context))
        : content;
      const itemId = WorkbenchItemIdSchema.parse(randomUUID());
      const entry = {
        threadId: identity.threadId, turnId: runtime.turnId, itemId, entryKey: itemId,
        input: toWorkbenchThreadUserInput(input.input), status: "pending" as const, attemptedAt: Date.now(), resolvedAt: null,
        requestId: null, canonicalItemId: null, clientUserMessageId: input.clientMessageId,
        dispatchSequence: null, error: null,
      };
      // Held in canonical history before delivery, so a dying process cannot take the steer with it.
      await this.options.transcript.recordSteer(entry);
      runtime.steer(entry, steerContent);
      await this.collectInputContext(identity.threadId, "steer");
      return { kind: "steered" as const, turnId: runtime.turnId };
    }
    if (runtime) throw new Error("Claude turn is already active.");
    const nativeHistoryExists = Boolean((await this.read(identity.threadId)).turns.at(-1));
    if (nativeHistoryExists && !await getSessionInfo(binding.nativeThreadId, { dir: binding.nativeLocation })) {
      throw new Error("Claude native session history is unavailable for continuation.");
    }
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : null;
    const contextWindow = await this.launchContextWindow(settings);
    // Instructions are rebuilt per launch, so an unfinished-turn continuation must replay this context. Activated
    // skills are not replayed: their bodies already sit in native history.
    const { activatedSkillPaths: _activated, ...turnContext }: WorkbenchMessageContext = input.context ?? {};
    const instructionInput = this.instructionInputFor(identity, binding, settings, turnContext, entry?.entryKind === "subagent" ? entry.name : null);
    const instructions = await this.options.buildInstructions(instructionInput);
    if (!instructions.trim()) throw new Error("Claude managed instructions are unavailable.");
    const promptContent = await this.withActivatedSkills(content, activatedSkillPaths, instructionInput);
    const hasQuestionnaireResponse = toWorkbenchThreadUserInput(input.input).some(isWorkbenchQuestionnaireResponsePart);
    const workingStatusInPrompt = entry?.entryKind === "thread" && entry.lifecycle.kind === "working"
      || hasQuestionnaireResponse;
    const managedPrompt = workingStatusInPrompt
      ? `${instructions}\n\n${WORKBENCH_THREAD_WORKING_STATUS_MESSAGE}` : instructions;
    const sdkContent = workingStatusInPrompt
      ? prefixClaudePrompt(WORKBENCH_THREAD_WORKING_STATUS_MESSAGE, promptContent) : promptContent;
    const { model } = instructionInput;
    const executable = this.options.resolveExecutable?.() ?? claudeExecutable();
    const usage = (await this.options.transcript.readContextUsage(identity.threadId))?.tokenUsage ?? null;
    // Earlier turns a reload killed never settled their usage; the log still has their calls.
    if (nativeHistoryExists) this.refreshUsage(identity.threadId);
    const turnId = await this.options.transcript.startTurn({
      threadId: identity.threadId, sessionId: binding.nativeThreadId, cwd: binding.nativeLocation,
      clientMessageId: input.clientMessageId, content: toWorkbenchThreadUserInput(input.input),
    });
    const scope = randomUUID();
    const endpoint = new URL("/daemon/mcp", this.options.daemonOrigin);
    endpoint.searchParams.set("provider", "claude");
    endpoint.searchParams.set("client", scope);
    if (instructionInput.subagentName) endpoint.searchParams.set("subagent", "true");
    const fakeEndpoint = process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT;
    const { sessions } = this.options;
    let session: Awaited<ReturnType<ClaudeSessionHost["launch"]>>;
    try {
      session = await sessions.launch({
        scope, captureStderr: Boolean(fakeEndpoint),
        options: viewEnv => ({
          cwd: binding.nativeLocation,
          pathToClaudeCodeExecutable: executable,
          ...(nativeHistoryExists ? { resume: binding.nativeThreadId } : { sessionId: binding.nativeThreadId }),
          ...(model ? { model } : {}),
          env: claudeEnvironment(fakeEndpoint, viewEnv, contextWindow),
          settingSources: [],
          skills: [],
          systemPrompt: { type: "custom", prompt: managedPrompt, snapshot: false },
          tools: ["Read", "Grep", "Edit", "Write"],
          disallowedTools: [
            "Bash", // wb shell (via codex)
            "Glob", // wb rg (via codex)
            "NotebookEdit", "Agent", "Task",
            "Skill", // wb skill
            "AskUserQuestion", // wb request_user_input
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // Hooks still run under bypassPermissions; they gate native edits with the shared claim policy.
          // They outlive this bridge generation, so collaborators are reached through the host.
          hooks: createClaudeFileClaimHooks({
            cwd: binding.nativeLocation,
            check: paths => sessions.call(handlers => handlers.checkFileClaims({
              cwd: binding.nativeLocation, threadId: identity.threadId, paths,
            })),
            onDenied: toolUseId => {
              void sessions.call(async handlers => handlers.recordNativeToolDenial(turnId, toolUseId)).catch((error: unknown) => {
                console.warn("[claude] native tool denial was not recorded",
                  error instanceof Error ? error.message.slice(0, 300) : "unknown failure");
              });
            },
          }),
          mcpServers: {
            wb: { type: "http", url: endpoint.href, alwaysLoad: true },
            [CLAUDE_COMMENTARY_SERVER_NAME]: createClaudeCommentaryServer(),
          },
          includePartialMessages: true,
          // Replay acknowledgements mark when a queued steer is folded into the conversation.
          extraArgs: { "replay-user-messages": null },
        }),
      });
    } catch (error) {
      await this.options.transcript.settleTurn(turnId, "failed");
      throw error;
    }
    const live = new ClaudeLiveTurn({
      session, scope, cwd: binding.nativeLocation,
      projectId: ProjectIdSchema.parse(identity.projectId),
      threadId: identity.threadId, turnId, workingStatusInPrompt, usage, contextWindow, context: turnContext,
      ...this.collaborators(identity.threadId, turnId, scope, turnContext),
    });
    this.completedTurns.delete(identity.threadId);
    this.live.set(identity.threadId, live);
    this.scopes.set(scope, live);
    // The registered runtime takes injected context ahead of its first prompt.
    await this.collectInputContext(identity.threadId, "start");
    const started = await live.start(sdkContent);
    this.track(started.task);
    const turn = (await this.read(identity.threadId)).turns.find(value => value.id === turnId);
    if (!turn) throw new Error("Claude turn admission did not materialise a turn.");
    const warnings = started.warning ? [started.warning] : [];
    try {
      if (entry && entry.entryKind !== "draft" && entry.profile) {
        await this.options.state.controller.recordAcceptedSelection(entry.profile, Date.now());
      }
    } catch (error) {
      const warning = `Turn accepted, but model/profile recency could not be saved: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"
      }`;
      console.warn("[claude]", warning);
      warnings.push(warning);
    }
    return { kind: "started" as const, turn, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
  }

  async messageAgent(input: Parameters<WorkbenchProviderThreads["messageAgent"]>[0]) {
    const result = await this.submit({
      threadId: input.threadId, clientMessageId: randomUUID(),
      input: [{ type: "text", text: createWorkbenchAgentMessageText(input.message), text_elements: [] }],
      intent: "continue", context: input.context,
    });
    return { turnId: result.kind === "started" ? result.turn.id : result.turnId };
  }

  /** Relaunch the thread's last completed turn context with the hidden unfinished-turn input, once. */
  async continueUnfinished(target: WorkbenchUnfinishedTurnTarget) {
    // A retired bridge generation hands live turns over; it never owns new continuations.
    if (this.options.signal.aborted) return;
    const identity = await this.identity(target.threadId);
    const completed = this.completedTurns.get(identity.threadId);
    // No record: a newer turn superseded it, or a bridge reload dropped it and the thread stays in needs attention.
    if (!completed || completed.turnId !== target.turnId || this.live.has(identity.threadId)) return;
    this.completedTurns.delete(identity.threadId);
    await this.submit({
      threadId: identity.threadId, clientMessageId: createWorkbenchThreadRecoveryId(`claude:${target.turnId}`),
      input: createWorkbenchUnfinishedTurnInput(), intent: "newTurn",
      ...(completed.context ? { context: completed.context } : {}),
    });
  }

  async rename(threadId: string, title: string) {
    const identity = await this.identity(threadId);
    const binding = identity.bindings.find(value => value.harness === "claude");
    if (!binding) throw new Error("Claude thread has no native session identity.");
    await renameSession(binding.nativeThreadId, title, { dir: binding.nativeLocation });
    // Public thread timestamps are seconds; canonical transcript observations use integer milliseconds.
    const createdAt = Math.round((await this.read(threadId)).createdAt * 1000);
    try {
      await this.options.transcript.rename(identity.threadId, {
        id: identity.projectId, rootPath: identity.projectRoot, createdAt,
      }, title);
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      console.error("[claude] title transcript failed",
        cause instanceof Error ? cause.message.slice(0, 500) : "unknown failure");
      throw error;
    }
    await this.options.identities.observe({
      native: { harness: "claude", nativeLocation: binding.nativeLocation,
        nativeThreadId: NativeThreadIdSchema.parse(binding.nativeThreadId) },
      projectId: ProjectIdSchema.parse(identity.projectId), projectRoot: identity.projectRoot,
      title, createdAt, updatedAt: Date.now(), activityAt: Date.now(),
    });
  }

  async compact(threadId: string) {
    const identity = await this.identity(threadId);
    if (this.live.has(identity.threadId)) throw new Error("Claude cannot compact during an active turn.");
    const binding = identity.bindings.find(value => value.harness === "claude");
    const turn = (await this.read(threadId)).turns.at(-1);
    if (!binding || !turn) throw new Error("Claude compaction requires an existing native turn.");
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : null;
    const instructions = await this.options.buildInstructions(this.instructionInputFor(identity, binding, settings, {}, entry?.entryKind === "subagent" ? entry.name : null));
    if (!instructions.trim()) throw new Error("Claude managed instructions are unavailable for compaction.");
    const contextWindow = await this.launchContextWindow(settings);
    const fakeEndpoint = process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT;
    const { viewsRoot } = this.options.sessions;
    const view = viewsRoot ? await ClaudeConfigView.create(viewsRoot) : null;
    let processExit: Promise<void> | null = null;
    let sdkQuery: Query | null = null;
    let compacted = false;
    try {
      sdkQuery = (this.options.createQuery ?? query)({
        prompt: "/compact",
        options: {
          cwd: binding.nativeLocation, resume: binding.nativeThreadId,
          pathToClaudeCodeExecutable: this.options.resolveExecutable?.() ?? claudeExecutable(),
          env: claudeEnvironment(fakeEndpoint, view?.env, contextWindow),
          settingSources: [],
          skills: [],
          systemPrompt: { type: "custom", prompt: instructions, snapshot: false },
          tools: [],
          spawnClaudeCodeProcess: options => spawnTrackedClaude(options, exit => { processExit = exit; }),
        },
      });
      const turnId = WorkbenchTurnIdSchema.parse(turn.id);
      for await (const message of sdkQuery) {
        if (message.type === "system" && (message.subtype === "compact_boundary" || message.subtype === "status")) {
          await this.options.transcript.recordCompactionMessage(identity.threadId, turnId, message);
          if (message.subtype === "compact_boundary") compacted = true;
        }
      }
      if (!compacted) {
        // Settle a compaction Claude started but never finished; with nothing open this records nothing.
        await this.options.transcript.reportCompaction(identity.threadId, turnId, "failed");
        throw new Error("Claude compaction ended without a native compact boundary.");
      }
    } finally {
      sdkQuery?.close();
      if (processExit) await processExit;
      await view?.dispose();
    }
  }

  async delete(threadId: string) {
    const identity = await this.identity(threadId);
    const binding = identity.bindings.find(value => value.harness === "claude");
    if (!binding) throw new Error("Claude thread has no native session identity.");
    await deleteSession(binding.nativeThreadId, { dir: binding.nativeLocation });
  }

  async interrupt(threadId: string, turnId: string) {
    const runtime = this.live.get(WorkbenchThreadIdSchema.parse(threadId));
    if (!runtime || runtime.turnId !== turnId) return;
    await runtime.interrupt();
  }

  /** Live while a runtime drives it, or while this daemon still admits, launches or settles its transcript scope. */
  async isTurnLive(threadId: string, turnId: string) {
    return this.live.get(WorkbenchThreadIdSchema.parse(threadId))?.turnId === turnId
      || this.options.transcript.ownsTurn(WorkbenchTurnIdSchema.parse(turnId));
  }

  async materialize(threadId: string, _turnIds: string[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.read(threadId);
  }

  async reconcile(input: Parameters<WorkbenchProviderThreads["reconcile"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    const thread = await this.read(input.threadId);
    const target = input.target;
    const turn = target.mode === "latest" ? thread.turns.at(-1)
      : target.mode === "exact" ? thread.turns.find(value => value.id === target.turnId)
        : thread.turns.findLast(value => value.id !== target.beforeTurnId);
    return { turnIds: turn ? [turn.id] : [], exhausted: true };
  }

  private async identity(threadId: string) {
    const identity = await this.options.identities.resolve({
      threadId: ThreadReferenceSchema.parse(threadId), harness: "claude",
    });
    if (!identity) throw new Error("Claude thread identity is unavailable.");
    return identity;
  }

  private instructionInputFor(
    identity: ClaudeIdentity,
    binding: ClaudeIdentity["bindings"][number],
    settings: { model?: string | null; agentPath?: string | null } | null | undefined,
    context: Pick<WorkbenchMessageContext, "workflowIds">,
    subagentName: string | null = null,
  ): ClaudeInstructionInput {
    return {
      cwd: binding.nativeLocation, projectId: identity.projectId, threadId: identity.threadId,
      model: settings?.model ?? null, agentPath: settings?.agentPath ?? null,
      workflowIds: context.workflowIds ?? [],
      subagentName,
    };
  }

  private async instructionInput(
    identity: ClaudeIdentity,
    binding: ClaudeIdentity["bindings"][number],
    context: WorkbenchMessageContext | undefined,
  ) {
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    return this.instructionInputFor(identity, binding, entry && entry.entryKind !== "draft" ? entry.profile?.settings : null, context ?? {}, entry?.entryKind === "subagent" ? entry.name : null);
  }

  /** Activated skill bodies join the user message, so they stay in native history across later launches. */
  private async withActivatedSkills(content: ClaudePromptContent, activatedSkillPaths: readonly string[], input: ClaudeInstructionInput) {
    if (!activatedSkillPaths.length) return content;
    const catalog = await this.options.buildActivatedSkills({ ...input, activatedSkillPaths });
    return catalog ? appendClaudePrompt(content, createWorkbenchActivatedSkillsInput(catalog).text) : content;
  }

  /** Accepted input is never undone because background context could not be collected. */
  private async collectInputContext(threadId: WorkbenchThreadId, trigger: WorkbenchContextTrigger) {
    try {
      await this.options.collectInputContext(threadId, trigger, this.options.signal);
    } catch (error) {
      console.warn("[claude] input-time agent context was not collected",
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure");
    }
  }
}

type ClaudeIdentity = Awaited<ReturnType<ClaudeThreadOperations["identity"]>>;

/*
 * Exports:
 * - ClaudeThreadOperationsOptions: bind SDK sessions to Workbench identity, state, lifecycle publication, claim policy, and managed MCP.
 * - default ClaudeThreadOperations: admit Claude turns and steers, gate native edits by claims, register live turns, and own native session operations.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  deleteSession, getSessionInfo, listSessions, query, renameSession,
  type Query, type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NativeThreadIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderContext } from "workbench-shared/workbench/provider/provider-context";
import type {
  WorkbenchProviderObservation, WorkbenchTranscriptNotification,
} from "workbench-shared/workbench/provider/provider-observation";
import {
  isWorkbenchQuestionnaireResponsePart,
  WORKBENCH_THREAD_WORKING_STATUS_MESSAGE,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import { toWorkbenchThreadUserInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchTranscriptReader from "../../WorkbenchTranscriptReader";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type WorkbenchApprovalController from "../../WorkbenchApprovalController";
import WorkbenchLocalApprovalTransport from "../../WorkbenchLocalApprovalTransport";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import type { WorkbenchToolAdmissionOptions } from "../../WorkbenchToolAdmissionController";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";
import ClaudeConfigView from "./ClaudeConfigView";
import ClaudeLiveTurn, { ClaudePromptQueue } from "./ClaudeLiveTurn";
import { claudePromptContent, prefixClaudePrompt } from "./claude-prompt-content";
import { createClaudeFileClaimHooks } from "./claude-file-claim-hook";

function spawnTrackedClaude(
  options: ClaudeSpawnOptions, onExit: (exit: Promise<void>) => void,
) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  onExit(new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  }));
  return child;
}

export interface ClaudeThreadOperationsOptions {
  daemonOrigin: string;
  createQuery?: typeof query;
  resolveExecutable?: () => string;
  /** Root for per-process sanitized Claude config views; null runs Claude against the daemon's config. */
  viewsRoot: string | null;
  identities: WorkbenchThreadIdentityController;
  projects: WorkbenchProjectCatalogController;
  questionnaires: WorkbenchQuestionnaireController;
  approvals: WorkbenchApprovalController;
  reader: WorkbenchTranscriptReader;
  state: WorkbenchThreadStateFeature;
  transcript: ClaudeTranscriptAdapter;
  signal: AbortSignal;
  observe(facts: WorkbenchProviderObservation): Promise<unknown>;
  broadcast(notification: WorkbenchTranscriptNotification): void;
  buildInstructions(input: {
    cwd: string; projectId: string; threadId: string; model: string | null; agentPath: string | null;
    workflowIds: readonly string[]; activatedSkillPaths: readonly string[];
  }): Promise<string>;
  /** Shared claim policy for native Edit/Write; paths are absolute. */
  checkFileClaims(request: { cwd: string; threadId: WorkbenchThreadId; paths: string[] }): Promise<{ allowed: boolean; uncoveredPaths: string[] }>;
}

export default class ClaudeThreadOperations implements WorkbenchProviderThreads {
  private readonly live = new Map<WorkbenchThreadId, ClaudeLiveTurn>();
  private readonly scopes = new Map<string, ClaudeLiveTurn>();
  private readonly pending = new Set<Promise<void>>();
  private readonly approvals: WorkbenchLocalApprovalTransport;

  constructor(private readonly options: ClaudeThreadOperationsOptions) {
    this.approvals = new WorkbenchLocalApprovalTransport("claude", () => options.approvals);
  }

  hasPendingWork() { return this.pending.size > 0 || this.live.size > 0; }

  async settle() {
    await Promise.all([...this.live.values()].map(runtime => this.interrupt(runtime.threadId, runtime.turnId)));
    await Promise.all(this.pending);
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
        if (input.text === WORKBENCH_THREAD_WORKING_STATUS_MESSAGE && runtime.workingStatusInPrompt) {
          return "admitted";
        }
        runtime.inject(input.text);
        return "admitted";
      }
      if (input.text === WORKBENCH_THREAD_WORKING_STATUS_MESSAGE) {
        const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
        if (entry?.entryKind === "thread" && entry.lifecycle.kind === "working") return "admitted";
      }
      return "unsupported";
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
    deliverApproval: async input => this.approvals.deliver(input),
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
    if (runtime && input.intent !== "newTurn") {
      if ("expectedTurnId" in input && input.expectedTurnId && input.expectedTurnId !== runtime.turnId) {
        throw new Error("Claude steer targeted a different turn.");
      }
      const itemId = WorkbenchItemIdSchema.parse(randomUUID());
      runtime.steer({
        threadId: identity.threadId, turnId: runtime.turnId, itemId, entryKey: itemId,
        input: toWorkbenchThreadUserInput(input.input), status: "pending", attemptedAt: Date.now(), resolvedAt: null,
        requestId: null, canonicalItemId: null, clientUserMessageId: input.clientMessageId,
        dispatchSequence: null, error: null,
      }, content);
      return { kind: "steered" as const, turnId: runtime.turnId };
    }
    if (runtime) throw new Error("Claude turn is already active.");
    const binding = identity.bindings.find(value => value.harness === "claude");
    if (!binding) throw new Error("Claude thread has no native session identity.");
    const nativeHistoryExists = Boolean((await this.read(identity.threadId)).turns.at(-1));
    if (nativeHistoryExists && !await getSessionInfo(binding.nativeThreadId, { dir: binding.nativeLocation })) {
      throw new Error("Claude native session history is unavailable for continuation.");
    }
    const entry = await this.options.state.controller.getCanonicalThreadEntry(identity.projectId, identity.threadId);
    const settings = entry && entry.entryKind !== "draft" ? entry.profile?.settings : null;
    const model = settings?.model ?? null;
    const instructions = await this.options.buildInstructions({
      cwd: binding.nativeLocation, projectId: identity.projectId, threadId: identity.threadId,
      model, agentPath: settings?.agentPath ?? null,
      workflowIds: input.context?.workflowIds ?? [],
      activatedSkillPaths: [...new Set([
        ...(input.context?.activatedSkillPaths ?? []),
        ...input.input.flatMap(part => part.type === "skill" ? [part.path] : []),
      ])],
    });
    if (!instructions.trim()) throw new Error("Claude managed instructions are unavailable.");
    const hasQuestionnaireResponse = toWorkbenchThreadUserInput(input.input).some(isWorkbenchQuestionnaireResponsePart);
    const workingStatusInPrompt = entry?.entryKind === "thread" && entry.lifecycle.kind === "working"
      || hasQuestionnaireResponse;
    const managedPrompt = workingStatusInPrompt
      ? `${instructions}\n\n${WORKBENCH_THREAD_WORKING_STATUS_MESSAGE}` : instructions;
    const sdkContent = workingStatusInPrompt
      ? prefixClaudePrompt(WORKBENCH_THREAD_WORKING_STATUS_MESSAGE, content) : content;
    const executable = this.options.resolveExecutable?.() ?? claudeExecutable();
    const usage = (await this.options.transcript.readContextUsage(identity.threadId))?.tokenUsage ?? null;
    const turnId = await this.options.transcript.startTurn({
      threadId: identity.threadId, sessionId: binding.nativeThreadId, cwd: binding.nativeLocation,
      clientMessageId: input.clientMessageId, content: toWorkbenchThreadUserInput(input.input),
    });
    const queue = new ClaudePromptQueue();
    const scope = randomUUID();
    const endpoint = new URL("/daemon/mcp", this.options.daemonOrigin);
    endpoint.searchParams.set("provider", "claude");
    endpoint.searchParams.set("client", scope);
    const fakeEndpoint = process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT;
    let view: ClaudeConfigView | null = null;
    let stderr = "";
    let processExit: Promise<void> | null = null;
    let sdkQuery: Query;
    try {
      view = this.options.viewsRoot ? await ClaudeConfigView.create(this.options.viewsRoot) : null;
      sdkQuery = (this.options.createQuery ?? query)({
        prompt: queue,
        options: {
          cwd: binding.nativeLocation,
          pathToClaudeCodeExecutable: executable,
          ...(nativeHistoryExists ? { resume: binding.nativeThreadId } : { sessionId: binding.nativeThreadId }),
          ...(model ? { model } : {}),
          env: claudeEnvironment(fakeEndpoint, view?.env),
          settingSources: [],
          skills: [],
          systemPrompt: { type: "custom", prompt: managedPrompt, snapshot: false },
          tools: ["Read", "Glob", "Grep", "Edit", "Write"],
          disallowedTools: ["Bash", "NotebookEdit", "Agent", "Task", "Skill", "AskUserQuestion"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // Hooks still run under bypassPermissions; they gate native edits with the shared claim policy.
          hooks: createClaudeFileClaimHooks({
            cwd: binding.nativeLocation,
            check: paths => this.options.checkFileClaims({ cwd: binding.nativeLocation, threadId: identity.threadId, paths }),
            onDenied: toolUseId => this.options.transcript.recordNativeToolDenial(turnId, toolUseId),
          }),
          mcpServers: { wb: { type: "http", url: endpoint.href, alwaysLoad: true } },
          includePartialMessages: true,
          // Replay acknowledgements mark when a queued steer is folded into the conversation.
          extraArgs: { "replay-user-messages": null },
          spawnClaudeCodeProcess: options => spawnTrackedClaude(options, exit => { processExit = exit; }),
          ...(fakeEndpoint ? { stderr: (data: string) => { stderr = (stderr + data).slice(-2000); } } : {}),
        },
      });
    } catch (error) {
      await view?.dispose();
      await this.options.transcript.settleTurn(turnId, "failed");
      throw error;
    }
    const live: ClaudeLiveTurn = new ClaudeLiveTurn({
      query: sdkQuery, queue, scope, cwd: binding.nativeLocation,
      projectId: ProjectIdSchema.parse(identity.projectId),
      threadId: identity.threadId, turnId, workingStatusInPrompt, usage,
      transcript: this.options.transcript,
      observe: this.options.observe,
      broadcast: this.options.broadcast,
      readTurn: async () => (await this.read(identity.threadId)).turns.find(turn => turn.id === turnId) ?? null,
      processExit: () => processExit ?? Promise.resolve(),
      stderr: () => stderr,
      release: async () => {
        if (this.live.get(identity.threadId) === live) this.live.delete(identity.threadId);
        this.scopes.delete(scope);
        await view?.dispose();
      },
    });
    this.live.set(identity.threadId, live);
    this.scopes.set(scope, live);
    const started = await live.start(sdkContent);
    this.pending.add(started.task);
    void started.task.then(
      () => { this.pending.delete(started.task); },
      error => {
        this.pending.delete(started.task);
        console.error("[claude] transcript settlement failed",
          error instanceof Error ? error.message.slice(0, 500) : "unknown failure");
      },
    );
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

  async requestShellApproval(
    request: Parameters<WorkbenchToolAdmissionOptions["approve"]>[0],
    signal: AbortSignal,
  ) {
    return this.approvals.request({
      threadId: request.caller.threadId, turnId: request.turnId, itemId: request.itemId, subject: request.subject,
    }, signal);
  }

  async messageAgent(input: Parameters<WorkbenchProviderThreads["messageAgent"]>[0]) {
    await this.submit({
      threadId: input.threadId, clientMessageId: randomUUID(),
      input: [{ type: "text", text: createWorkbenchAgentMessageText(input.message), text_elements: [] }],
      intent: "continue", context: input.context,
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
    const instructions = await this.options.buildInstructions({
      cwd: binding.nativeLocation, projectId: identity.projectId, threadId: identity.threadId,
      model: settings?.model ?? null, agentPath: settings?.agentPath ?? null,
      workflowIds: [], activatedSkillPaths: [],
    });
    if (!instructions.trim()) throw new Error("Claude managed instructions are unavailable for compaction.");
    const fakeEndpoint = process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT;
    const view = this.options.viewsRoot ? await ClaudeConfigView.create(this.options.viewsRoot) : null;
    let processExit: Promise<void> | null = null;
    let sdkQuery: Query | null = null;
    let compacted = false;
    try {
      sdkQuery = (this.options.createQuery ?? query)({
        prompt: "/compact",
        options: {
          cwd: binding.nativeLocation, resume: binding.nativeThreadId,
          pathToClaudeCodeExecutable: this.options.resolveExecutable?.() ?? claudeExecutable(),
          env: claudeEnvironment(fakeEndpoint, view?.env),
          settingSources: [],
          skills: [],
          systemPrompt: { type: "custom", prompt: instructions, snapshot: false },
          tools: [],
          spawnClaudeCodeProcess: options => spawnTrackedClaude(options, exit => { processExit = exit; }),
        },
      });
      for await (const message of sdkQuery) {
        if (message.type === "system" && message.subtype === "compact_boundary") {
          await this.options.transcript.recordCompaction(identity.threadId, WorkbenchTurnIdSchema.parse(turn.id), message);
          compacted = true;
        }
      }
      if (!compacted) throw new Error("Claude compaction ended without a native compact boundary.");
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
}

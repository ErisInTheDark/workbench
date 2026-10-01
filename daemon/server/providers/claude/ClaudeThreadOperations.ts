/*
 * Exports:
 * - ClaudeThreadOperationsOptions: bind SDK sessions to Workbench identity, state, and managed MCP.
 * - default ClaudeThreadOperations: own live Claude queries, prompt admission, interruption, and native resume.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  deleteSession, getSessionInfo, listSessions, query, renameSession,
  type Query, type SDKMessage, type SDKUserMessage, type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NativeThreadIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchItemIdSchema,
  WorkbenchThreadIdSchema, WorkbenchTurnIdSchema,
  type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type { WorkbenchProviderThreads } from "workbench-shared/workbench/provider/provider-thread";
import type { WorkbenchProviderInteractions } from "workbench-shared/workbench/provider/provider-interaction";
import type { WorkbenchProviderContext } from "workbench-shared/workbench/provider/provider-context";
import {
  isWorkbenchQuestionnaireResponsePart,
  WORKBENCH_THREAD_WORKING_STATUS_MESSAGE,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import { toWorkbenchThreadUserInput, type WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import type WorkbenchThreadIdentityController from "../../WorkbenchThreadIdentityController";
import type WorkbenchTranscriptReader from "../../WorkbenchTranscriptReader";
import type WorkbenchProjectCatalogController from "../../WorkbenchProjectCatalogController";
import type WorkbenchThreadStateFeature from "../../WorkbenchThreadStateFeature";
import type WorkbenchQuestionnaireController from "../../WorkbenchQuestionnaireController";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";
import type { WorkbenchToolAdmissionOptions } from "../../WorkbenchToolAdmissionController";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";

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

function promptText(parts: readonly WorkbenchUserInput[]) {
  return parts.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "skill") return `/${part.name}`;
    if (part.type === "mention") return `@${part.path}`;
    throw new Error(`Claude provider does not yet support ${part.type} input.`);
  }).join("\n");
}

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(value: SDKUserMessage) {
    if (this.closed) throw new Error("Claude prompt queue has closed.");
    this.values.push(value);
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
    }
  }
}

interface LiveQuery {
  query: Query;
  queue: PromptQueue;
  scope: string;
  sessionId: string;
  cwd: string;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  task: Promise<void>;
  stopped: boolean;
  workingStatusInPrompt: boolean;
  processExit: () => Promise<void>;
  stderr: () => string;
}

export interface ClaudeThreadOperationsOptions {
  daemonOrigin: string;
  createQuery?: typeof query;
  resolveExecutable?: () => string;
  identities: WorkbenchThreadIdentityController;
  projects: WorkbenchProjectCatalogController;
  questionnaires: WorkbenchQuestionnaireController;
  reader: WorkbenchTranscriptReader;
  state: WorkbenchThreadStateFeature;
  transcript: ClaudeTranscriptAdapter;
  signal: AbortSignal;
  buildInstructions(input: {
    cwd: string; projectId: string; threadId: string; model: string | null; agentPath: string | null;
    workflowIds: readonly string[]; activatedSkillPaths: readonly string[];
  }): Promise<string>;
}

export default class ClaudeThreadOperations implements WorkbenchProviderThreads {
  private readonly live = new Map<WorkbenchThreadId, LiveQuery>();
  private readonly scopes = new Map<string, LiveQuery>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: ClaudeThreadOperationsOptions) {}

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
        runtime.queue.push(this.sdkPrompt(input.text, true));
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
    return thread;
  }

  async readLatest(threadId: string) { return this.read(threadId); }
  async latestTurn(threadId: string) { return (await this.read(threadId)).turns.at(-1) ?? null; }
  async admitTurn(threadId: string) { await this.read(threadId); }

  async submit(input: Parameters<WorkbenchProviderThreads["submit"]>[0]) {
    this.options.signal.throwIfAborted();
    const identity = await this.identity(input.threadId);
    const runtime = this.live.get(identity.threadId);
    const text = promptText(input.input);
    if (runtime && input.intent !== "newTurn") {
      if ("expectedTurnId" in input && input.expectedTurnId && input.expectedTurnId !== runtime.turnId) {
        throw new Error("Claude steer targeted a different turn.");
      }
      const itemId = WorkbenchItemIdSchema.parse(randomUUID());
      const now = Date.now();
      await this.options.transcript.recordSteer({
        threadId: identity.threadId, turnId: runtime.turnId, itemId, entryKey: itemId,
        input: toWorkbenchThreadUserInput(input.input), status: "sent", attemptedAt: now, resolvedAt: now,
        requestId: null, canonicalItemId: itemId, clientUserMessageId: input.clientMessageId,
        dispatchSequence: null, error: null,
      });
      runtime.queue.push(this.sdkPrompt(text));
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
    const sdkText = workingStatusInPrompt
      ? `${WORKBENCH_THREAD_WORKING_STATUS_MESSAGE}\n\n${text}` : text;
    const executable = this.options.resolveExecutable?.() ?? claudeExecutable();
    const turnId = await this.options.transcript.startTurn({
      threadId: identity.threadId, sessionId: binding.nativeThreadId, cwd: binding.nativeLocation,
      clientMessageId: input.clientMessageId, content: toWorkbenchThreadUserInput(input.input),
    });
    const queue = new PromptQueue();
    const scope = randomUUID();
    const endpoint = new URL("/daemon/mcp", this.options.daemonOrigin);
    endpoint.searchParams.set("provider", "claude");
    endpoint.searchParams.set("client", scope);
    const fakeEndpoint = process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT;
    const env = claudeEnvironment(fakeEndpoint);
    let stderr = "";
    let processExit: Promise<void> | null = null;
    let sdkQuery: Query;
    try {
      sdkQuery = (this.options.createQuery ?? query)({
        prompt: queue,
        options: {
          cwd: binding.nativeLocation,
          pathToClaudeCodeExecutable: executable,
          ...(nativeHistoryExists ? { resume: binding.nativeThreadId } : { sessionId: binding.nativeThreadId }),
          ...(model ? { model } : {}),
          env,
          settingSources: [],
          skills: [],
          systemPrompt: { type: "custom", prompt: managedPrompt, snapshot: false },
          tools: ["Read", "Glob", "Grep", "Edit", "Write"],
          disallowedTools: ["Bash", "NotebookEdit", "Agent", "Task", "Skill", "AskUserQuestion"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          mcpServers: { wb: { type: "http", url: endpoint.href, alwaysLoad: true } },
          includePartialMessages: true,
          spawnClaudeCodeProcess: options => spawnTrackedClaude(options, exit => { processExit = exit; }),
          ...(fakeEndpoint ? { stderr: (data: string) => { stderr = (stderr + data).slice(-2000); } } : {}),
        },
      });
    } catch (error) {
      await this.options.transcript.settleTurn(turnId, "failed");
      throw error;
    }
    const live: LiveQuery = {
      query: sdkQuery, queue, scope, sessionId: binding.nativeThreadId,
      cwd: binding.nativeLocation, threadId: identity.threadId, turnId, task: Promise.resolve(),
      stopped: false,
      workingStatusInPrompt,
      processExit: () => processExit ?? Promise.resolve(),
      stderr: () => stderr,
    };
    this.live.set(identity.threadId, live);
    this.scopes.set(scope, live);
    queue.push(this.sdkPrompt(sdkText));
    live.task = this.consume(live);
    this.pending.add(live.task);
    void live.task.then(
      () => { this.pending.delete(live.task); },
      error => {
        this.pending.delete(live.task);
        console.error("[claude] transcript settlement failed",
          error instanceof Error ? error.message.slice(0, 500) : "unknown failure");
      },
    );
    const turn = (await this.read(identity.threadId)).turns.at(-1);
    if (!turn) throw new Error("Claude turn admission did not materialise a turn.");
    try {
      if (entry && entry.entryKind !== "draft" && entry.profile) {
        await this.options.state.controller.recordAcceptedSelection(entry.profile, Date.now());
      }
      return { kind: "started" as const, turn };
    } catch (error) {
      const warning = `Turn accepted, but model/profile recency could not be saved: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"
      }`;
      console.warn("[claude]", warning);
      return { kind: "started" as const, turn, warning };
    }
  }

  private sdkPrompt(text: string, synthetic = false): SDKUserMessage {
    return {
      type: "user", message: { role: "user", content: text },
      parent_tool_use_id: null, uuid: randomUUID(),
      ...(synthetic ? { isSynthetic: true } : {}),
    };
  }

  async requestShellApproval(
    request: Parameters<WorkbenchToolAdmissionOptions["approve"]>[0],
    signal: AbortSignal,
  ) {
    return this.options.questionnaires.requestShellApproval({
      callerThreadId: request.caller.threadId, cwd: request.cwd, command: request.command,
    }, signal);
  }

  private async consume(runtime: LiveQuery) {
    let result: Extract<SDKMessage, { type: "result" }> | null = null;
    try {
      for await (const message of runtime.query) {
        if (message.type === "assistant") {
          await this.options.transcript.recordAssistant(runtime.threadId, runtime.turnId, message);
        } else if (message.type === "user") {
          await this.options.transcript.recordNativeToolResults(runtime.threadId, message);
        } else if (message.type === "system" && message.subtype === "compact_boundary") {
          await this.options.transcript.recordCompaction(runtime.threadId, runtime.turnId, message);
        } else if (message.type === "result") {
          result = message;
          break;
        }
      }
      if (!runtime.stopped) await this.options.transcript.settleTurn(runtime.turnId,
        result?.subtype === "success" && !result.is_error ? "completed" : "failed");
    } catch (error) {
      if (!runtime.stopped) console.error("[claude] query failed",
        error instanceof Error ? error.message.slice(0, 500) : "unknown failure",
        runtime.stderr().slice(-1000));
      if (!runtime.stopped) await this.options.transcript.settleTurn(runtime.turnId, "failed");
    } finally {
      runtime.queue.close();
      runtime.query.close();
      await runtime.processExit();
      this.live.delete(runtime.threadId);
      this.scopes.delete(runtime.scope);
    }
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
    let processExit: Promise<void> | null = null;
    const sdkQuery = query({
      prompt: "/compact",
      options: {
        cwd: binding.nativeLocation, resume: binding.nativeThreadId,
        pathToClaudeCodeExecutable: claudeExecutable(),
        env: claudeEnvironment(fakeEndpoint),
        settingSources: [],
        skills: [],
        systemPrompt: { type: "custom", prompt: instructions, snapshot: false },
        tools: [],
        spawnClaudeCodeProcess: options => spawnTrackedClaude(options, exit => { processExit = exit; }),
      },
    });
    let compacted = false;
    try {
      for await (const message of sdkQuery) {
        if (message.type === "system" && message.subtype === "compact_boundary") {
          await this.options.transcript.recordCompaction(identity.threadId, WorkbenchTurnIdSchema.parse(turn.id), message);
          compacted = true;
        }
      }
      if (!compacted) throw new Error("Claude compaction ended without a native compact boundary.");
    } finally {
      sdkQuery.close();
      if (processExit) await processExit;
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
    runtime.stopped = true;
    try { await runtime.query.interrupt(); }
    finally {
      runtime.queue.close();
      runtime.query.close();
      await runtime.task;
      this.live.delete(runtime.threadId);
      this.scopes.delete(runtime.scope);
      await this.options.transcript.settleTurn(runtime.turnId, "interrupted");
    }
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

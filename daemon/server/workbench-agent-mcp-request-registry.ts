/*
 * Exports:
 * - WorkbenchAgentMcpPendingRequest: describe one active request for runtime-drain diagnostics.
 * - WorkbenchAgentMcpThreadWaitState: describe active waits owned by one Workbench thread.
 * - WorkbenchAgentMcpRequestRegistry: own MCP request cancellation, wait observation, reload-safe command re-entry, the current MCP tool generation, and the exec node's shell runner.
 * - getProcessWorkbenchAgentMcpRequestRegistry: access reload-stable process state through current module methods.
 * - isWorkbenchAgentMcpSteerInterruption: identify expected steer cancellation across module generations.
 */
import {
  NativeThreadIdSchema,
  WorkbenchThreadIdSchema,
  type NativeThreadId,
  type WorkbenchThreadId,
} from "workbench-shared/workbench/identity";
import {
  createWorkbenchAgentMcpRuntimeReloadInterruption,
  isWorkbenchAgentMcpRuntimeReloadInterruption,
  type WorkbenchAgentCommandRequest,
  type WorkbenchAgentMcpRuntimeDrainPolicy,
} from "./lib/workbench/commands/workbench-agent-command-definition";
import type { WorkbenchMcpToolGeneration } from "./workbench-mcp-ingress";
import type { WorkbenchShellRun, WorkbenchShellRunResult } from "./provider-execution";

type WorkbenchAgentMcpRequestId = number | string;
type WorkbenchAgentMcpClientScope = string;
type WorkbenchAgentMcpRuntimeOwner = object;
type WorkbenchAgentMcpRuntimeDrainPhase = "deadline" | "immediate";
type WorkbenchAgentMcpCommandExecutor = (
  request: WorkbenchAgentCommandRequest,
  signal: AbortSignal,
) => Promise<Response>;

interface WorkbenchAgentMcpCommandGeneration {
  controller: AbortController;
  execute: WorkbenchAgentMcpCommandExecutor;
  owner: object;
}

interface WorkbenchAgentMcpRequestEntry {
  controller: AbortController;
  drainIndependent: boolean;
  owner: WorkbenchAgentMcpRuntimeOwner;
  policy: WorkbenchAgentMcpRuntimeDrainPolicy | null;
  startedAt: number;
  steerInterruptible?: boolean;
  /** Pre-patch process state retained only until its live request unregisters. */
  threadId?: string;
  workbenchThreadId?: WorkbenchThreadId;
  toolName: string;
}

interface WorkbenchAgentMcpRuntimeOwnerState {
  phase: "active" | WorkbenchAgentMcpRuntimeDrainPhase;
  released: boolean;
}

interface WorkbenchAgentMcpToolGenerationSlot {
  generation: WorkbenchMcpToolGeneration;
  owner: object;
}

type WorkbenchAgentMcpShellRunner = (run: WorkbenchShellRun, signal: AbortSignal) => Promise<WorkbenchShellRunResult>;

interface WorkbenchAgentMcpRequestRegistryState {
  commandGeneration: WorkbenchAgentMcpCommandGeneration | null;
  /** The MCP generation that serves requests; held here so in-flight requests never capture one. */
  toolGeneration: WorkbenchAgentMcpToolGenerationSlot | null;
  toolGenerationWaiters: Set<() => void>;
  /** The exec node's entry for running prepared shells; it leases only that node for each command. */
  shellRunner: { owner: object; run: WorkbenchAgentMcpShellRunner } | null;
  shellRunnerWaiters: Set<() => void>;
  disposed: boolean;
  exitHookInstalled: boolean;
  threadWaitListeners: Set<(state: WorkbenchAgentMcpThreadWaitState | WorkbenchAgentMcpLegacyThreadWaitState) => void>;
  ownerStates: WeakMap<WorkbenchAgentMcpRuntimeOwner, WorkbenchAgentMcpRuntimeOwnerState>;
  requestsByClient: Map<WorkbenchAgentMcpClientScope, Map<WorkbenchAgentMcpRequestId, WorkbenchAgentMcpRequestEntry>>;
}

interface WorkbenchAgentMcpRequestRegistrationOptions {
  owner: WorkbenchAgentMcpRuntimeOwner;
  policy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  steerInterruptible?: boolean;
  toolName: string;
}

export interface WorkbenchAgentMcpPendingRequest {
  ageMs: number;
  policy: WorkbenchAgentMcpRuntimeDrainPolicy | null;
  toolName: string;
}

export interface WorkbenchAgentMcpThreadWaitState {
  identityKind: "workbench";
  threadId: WorkbenchThreadId;
  toolNames: string[];
}

interface WorkbenchAgentMcpLegacyThreadWaitState {
  threadId: string;
  toolNames: string[];
}

const PROCESS_REGISTRY_KEY = Symbol.for("workbench.agentMcpRequestRegistry.v2");
const STEER_INTERRUPTION_KEY = Symbol.for("workbench.agentMcpSteerInterruption.v1");

function createWorkbenchAgentMcpSteerInterruption(reason: string) {
  const error = new Error(reason);
  Reflect.set(error, STEER_INTERRUPTION_KEY, true);
  return error;
}

export function isWorkbenchAgentMcpSteerInterruption(error: unknown) {
  return error instanceof Error && Reflect.get(error, STEER_INTERRUPTION_KEY) === true;
}

function createState(): WorkbenchAgentMcpRequestRegistryState {
  return {
    commandGeneration: null,
    toolGeneration: null,
    toolGenerationWaiters: new Set(),
    shellRunner: null,
    shellRunnerWaiters: new Set(),
    disposed: false,
    exitHookInstalled: false,
    threadWaitListeners: new Set(),
    ownerStates: new WeakMap(),
    requestsByClient: new Map(),
  };
}

function disposeState(state: WorkbenchAgentMcpRequestRegistryState, reason: string) {
  if (state.disposed) return;
  state.disposed = true;
  state.commandGeneration?.controller.abort(new Error(reason));
  state.commandGeneration = null;
  state.toolGeneration = null;
  for (const wake of [...state.toolGenerationWaiters]) wake();
  state.shellRunner = null;
  for (const wake of [...state.shellRunnerWaiters]) wake();
  for (const requests of state.requestsByClient.values()) {
    for (const entry of requests.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(new Error(reason));
    }
  }
  state.requestsByClient.clear();
  state.threadWaitListeners.clear();
  state.ownerStates = new WeakMap();
}

function getProcessState() {
  let state = Reflect.get(globalThis, PROCESS_REGISTRY_KEY) as WorkbenchAgentMcpRequestRegistryState | undefined;
  if (!state) {
    state = createState();
    Reflect.set(globalThis, PROCESS_REGISTRY_KEY, state);
  }
  state.commandGeneration ??= null;
  // Process state outlives module generations, so fields added later start empty on older state.
  state.toolGeneration ??= null;
  state.toolGenerationWaiters ??= new Set();
  state.shellRunner ??= null;
  state.shellRunnerWaiters ??= new Set();
  state.threadWaitListeners ??= new Set();
  if (!state.exitHookInstalled) {
    state.exitHookInstalled = true;
    process.once("exit", () => disposeState(state, "Workbench daemon is shutting down."));
  }
  return state;
}

function phaseCancels(policy: WorkbenchAgentMcpRuntimeDrainPolicy | null, phase: WorkbenchAgentMcpRuntimeDrainPhase) {
  return policy === "abort-immediately" || (policy === "abort-at-deadline" && phase === "deadline");
}

export class WorkbenchAgentMcpRequestRegistry {
  constructor(
    private readonly state = createState(),
    private readonly now: () => number = Date.now,
  ) {}

  register(
    clientScope: WorkbenchAgentMcpClientScope,
    requestId: WorkbenchAgentMcpRequestId,
    options: WorkbenchAgentMcpRequestRegistrationOptions,
  ) {
    if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
    const ownerState = this.state.ownerStates.get(options.owner) ?? { phase: "active", released: false };
    if (ownerState.released) throw new Error("Workbench MCP runtime owner is disposed.");
    this.state.ownerStates.set(options.owner, ownerState);
    const requests = this.state.requestsByClient.get(clientScope) ?? new Map<WorkbenchAgentMcpRequestId, WorkbenchAgentMcpRequestEntry>();
    if (requests.has(requestId)) throw new Error(`Workbench MCP request ID is already active for client ${clientScope}: ${requestId}`);
    const entry: WorkbenchAgentMcpRequestEntry = {
      controller: new AbortController(),
      drainIndependent: false,
      owner: options.owner,
      policy: options.policy ?? null,
      startedAt: this.now(),
      steerInterruptible: options.steerInterruptible,
      toolName: options.toolName,
    };
    requests.set(requestId, entry);
    this.state.requestsByClient.set(clientScope, requests);
    if (ownerState.phase !== "active" && phaseCancels(entry.policy, ownerState.phase)) {
      entry.controller.abort(new Error("Workbench MCP tool call was cancelled for runtime reload."));
    }
    return {
      markDrainIndependent: () => { entry.drainIndependent = true; },
      setWorkbenchThreadId: (threadId: WorkbenchThreadId) => {
        const workbenchThreadId = WorkbenchThreadIdSchema.parse(threadId);
        if (entry.workbenchThreadId === workbenchThreadId) return;
        if (entry.workbenchThreadId) throw new Error("Workbench MCP request thread identity cannot change.");
        entry.workbenchThreadId = workbenchThreadId;
        if (entry.steerInterruptible) this.notifyThreadWaits(workbenchThreadId);
      },
      signal: entry.controller.signal,
      unregister: () => {
        if (requests.get(requestId) !== entry) return;
        requests.delete(requestId);
        if (requests.size === 0 && this.state.requestsByClient.get(clientScope) === requests) {
          this.state.requestsByClient.delete(clientScope);
        }
        if (entry.steerInterruptible && entry.workbenchThreadId) this.notifyThreadWaits(entry.workbenchThreadId);
      },
    };
  }

  activateCommandExecutor(owner: object, execute: WorkbenchAgentMcpCommandExecutor) {
    if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
    const previous = this.state.commandGeneration;
    const current = { controller: new AbortController(), execute, owner };
    this.state.commandGeneration = current;
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(createWorkbenchAgentMcpRuntimeReloadInterruption());
    }
  }

  releaseCommandExecutor(owner: object) {
    const current = this.state.commandGeneration;
    if (!current || current.owner !== owner) return;
    this.state.commandGeneration = null;
    if (!current.controller.signal.aborted) {
      current.controller.abort(new Error("Workbench command runtime is shutting down."));
    }
  }

  activateToolGeneration(owner: object, generation: WorkbenchMcpToolGeneration) {
    if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
    this.state.toolGeneration = { generation, owner };
    for (const wake of [...this.state.toolGenerationWaiters]) wake();
  }

  releaseToolGeneration(owner: object) {
    if (this.state.toolGeneration?.owner === owner) this.state.toolGeneration = null;
  }

  /** The current MCP generation, waiting through a reload's gap between retirement and replacement. */
  async awaitToolGeneration(signal?: AbortSignal): Promise<WorkbenchMcpToolGeneration> {
    return (await this.awaitSlot(() => this.state.toolGeneration, this.state.toolGenerationWaiters, signal)).generation;
  }

  activateShellRunner(owner: object, run: WorkbenchAgentMcpShellRunner) {
    if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
    this.state.shellRunner = { owner, run };
    for (const wake of [...this.state.shellRunnerWaiters]) wake();
  }

  releaseShellRunner(owner: object) {
    if (this.state.shellRunner?.owner === owner) this.state.shellRunner = null;
  }

  /** Runs a prepared shell through the exec node, waiting through its reload gap; only the caller's signal cancels. */
  async executeShell(run: WorkbenchShellRun, signal: AbortSignal) {
    return await (await this.awaitSlot(() => this.state.shellRunner, this.state.shellRunnerWaiters, signal)).run(run, signal);
  }

  private async awaitSlot<T>(read: () => T | null, waiters: Set<() => void>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
      const current = read();
      if (current) return current;
      await new Promise<void>(resolve => {
        const wake = () => {
          waiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  async executeCommand(request: WorkbenchAgentCommandRequest, callerSignal: AbortSignal) {
    const lifetime = new AbortController();
    Object.defineProperty(request, "lifetimeSignal", {
      configurable: true,
      value: AbortSignal.any([callerSignal, lifetime.signal]),
    });
    try {
      return await this.executeCommandGenerations(request, callerSignal);
    } finally {
      lifetime.abort(new Error("Workbench command invocation ended."));
    }
  }

  private async executeCommandGenerations(request: WorkbenchAgentCommandRequest, callerSignal: AbortSignal) {
    while (true) {
      callerSignal.throwIfAborted();
      const generation = this.state.commandGeneration;
      if (!generation) throw new Error("Workbench command runtime is unavailable.");
      const signal = AbortSignal.any([callerSignal, generation.controller.signal]);
      try {
        const response = await generation.execute(request, signal);
        callerSignal.throwIfAborted();
        if (!generation.controller.signal.aborted) return response;
        const reason = generation.controller.signal.reason;
        if (!isWorkbenchAgentMcpRuntimeReloadInterruption(reason)) throw reason;
        if (response.ok) return response;
        if (this.state.commandGeneration === generation) throw reason;
      } catch (error) {
        callerSignal.throwIfAborted();
        if (
          !generation.controller.signal.aborted
          || !isWorkbenchAgentMcpRuntimeReloadInterruption(generation.controller.signal.reason)
        ) {
          throw error;
        }
        if (this.state.commandGeneration === generation) throw generation.controller.signal.reason;
      }
    }
  }

  subscribeThreadWaits(
    listener: (state: WorkbenchAgentMcpThreadWaitState) => void,
    resolveLegacyThreadId?: (nativeThreadId: NativeThreadId) => WorkbenchThreadId,
  ) {
    this.associateLegacyThreadWaits(resolveLegacyThreadId);
    const compatibleListener = (state: WorkbenchAgentMcpThreadWaitState | WorkbenchAgentMcpLegacyThreadWaitState) => {
      if ("identityKind" in state) {
        listener(state);
        return;
      }
      if (!resolveLegacyThreadId) throw new Error("A live pre-reload MCP wait requires native thread identity resolution.");
      const nativeThreadId = NativeThreadIdSchema.parse(state.threadId);
      const workbenchThreadId = resolveLegacyThreadId(nativeThreadId);
      this.associateLegacyThreadWaits(resolveLegacyThreadId, nativeThreadId);
      listener(this.threadWaitState(workbenchThreadId));
    };
    this.state.threadWaitListeners.add(compatibleListener);
    for (const state of this.listThreadWaitStates()) listener(state);
    return () => this.state.threadWaitListeners.delete(compatibleListener);
  }

  private listThreadWaitStates() {
    const toolNamesByThreadId = new Map<string, Set<string>>();
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (!entry.steerInterruptible || !entry.workbenchThreadId) continue;
        const toolNames = toolNamesByThreadId.get(entry.workbenchThreadId) ?? new Set<string>();
        toolNames.add(entry.toolName);
        toolNamesByThreadId.set(entry.workbenchThreadId, toolNames);
      }
    }
    return [...toolNamesByThreadId]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, toolNames]) => ({
        identityKind: "workbench" as const,
        threadId: WorkbenchThreadIdSchema.parse(threadId),
        toolNames: [...toolNames].sort((left, right) => left.localeCompare(right)),
      }));
  }

  private notifyThreadWaits(threadId: WorkbenchThreadId) {
    const state = this.threadWaitState(threadId);
    for (const listener of this.state.threadWaitListeners) listener(state);
  }

  private threadWaitState(threadId: WorkbenchThreadId): WorkbenchAgentMcpThreadWaitState {
    const toolNames = new Set<string>();
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.steerInterruptible && entry.workbenchThreadId === threadId) toolNames.add(entry.toolName);
      }
    }
    return {
      identityKind: "workbench",
      threadId,
      toolNames: [...toolNames].sort((left, right) => left.localeCompare(right)),
    };
  }

  private associateLegacyThreadWaits(
    resolveLegacyThreadId: ((nativeThreadId: NativeThreadId) => WorkbenchThreadId) | undefined,
    matchingNativeThreadId?: NativeThreadId,
  ) {
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (!entry.steerInterruptible || entry.workbenchThreadId || !entry.threadId) continue;
        const nativeThreadId = NativeThreadIdSchema.parse(entry.threadId);
        if (matchingNativeThreadId && nativeThreadId !== matchingNativeThreadId) continue;
        if (!resolveLegacyThreadId) throw new Error("A live pre-reload MCP wait requires native thread identity resolution.");
        entry.workbenchThreadId = resolveLegacyThreadId(nativeThreadId);
      }
    }
  }

  beginRuntimeDrain(owner: WorkbenchAgentMcpRuntimeOwner, phase: WorkbenchAgentMcpRuntimeDrainPhase, reason: string) {
    const ownerState = this.state.ownerStates.get(owner) ?? { phase: "active", released: false };
    if (ownerState.phase === "deadline" || (ownerState.phase === "immediate" && phase === "immediate")) return 0;
    ownerState.phase = phase;
    this.state.ownerStates.set(owner, ownerState);
    let cancelled = 0;
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.owner !== owner || entry.controller.signal.aborted || !phaseCancels(entry.policy, phase)) continue;
        entry.controller.abort(new Error(reason));
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancel(clientScope: WorkbenchAgentMcpClientScope, requestId: WorkbenchAgentMcpRequestId, reason?: string) {
    const controller = this.state.requestsByClient.get(clientScope)?.get(requestId)?.controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error(reason?.trim() || "Workbench MCP tool call was cancelled."));
    return true;
  }

  interruptThreadWaits(
    threadId: WorkbenchThreadId,
    reason = "Workbench MCP wait was interrupted by a user steer.",
    excludedToolNames: readonly string[] = [],
  ) {
    const workbenchThreadId = WorkbenchThreadIdSchema.parse(threadId);
    let interrupted = 0;
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (!entry.steerInterruptible || entry.workbenchThreadId !== workbenchThreadId
          || entry.controller.signal.aborted || excludedToolNames.includes(entry.toolName)) continue;
        entry.controller.abort(createWorkbenchAgentMcpSteerInterruption(reason));
        interrupted += 1;
      }
    }
    return interrupted;
  }

  listRuntimeDrainPending(owner: WorkbenchAgentMcpRuntimeOwner): WorkbenchAgentMcpPendingRequest[] {
    const now = this.now();
    const pending: WorkbenchAgentMcpPendingRequest[] = [];
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.owner !== owner || entry.drainIndependent) continue;
        pending.push({
          ageMs: Math.max(0, now - entry.startedAt),
          policy: entry.policy,
          toolName: entry.toolName,
        });
      }
    }
    return pending.sort((left, right) => left.toolName.localeCompare(right.toolName));
  }

  releaseRuntimeOwner(owner: WorkbenchAgentMcpRuntimeOwner) {
    const ownerState = this.state.ownerStates.get(owner) ?? { phase: "active", released: false };
    ownerState.released = true;
    this.state.ownerStates.set(owner, ownerState);
  }

  dispose(reason = "Workbench daemon is shutting down.") {
    disposeState(this.state, reason);
  }
}

export function getProcessWorkbenchAgentMcpRequestRegistry() {
  return new WorkbenchAgentMcpRequestRegistry(getProcessState());
}

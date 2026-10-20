/*
 * Exports:
 * - WorkbenchAgentMcpPendingRequest: describe one active request for runtime-drain diagnostics.
 * - WorkbenchAgentMcpThreadWaitState: describe active waits owned by one Workbench thread.
 * - WorkbenchAgentMcpShellQueueEntry: one live shell's expensive-queue timing and the transcript references naming it.
 * - WorkbenchAgentBatchTurn: how a serial call's turn in its provider tool batch ended.
 * - WorkbenchAgentMcpRequestRegistry: own MCP request cancellation, user shell stops and queue skips, provider tool batches and serial call
 *   turns, wait and shell-queue observation, reload-safe command re-entry, the current MCP tool generation, and the exec node's shell runner.
 * - getProcessWorkbenchAgentMcpRequestRegistry: access reload-stable process state through current module methods.
 * - isWorkbenchAgentMcpSteerInterruption: identify expected steer cancellation across module generations.
 * - isWorkbenchAgentMcpUserStop: identify a user's stop of one shell command across module generations.
 */
import { formatDuration } from "workbench-shared/workbench/format-duration";
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
import type { WorkbenchCommandQueueTicket } from "./WorkbenchCommandCapacity";

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
  deferredSteerInterruptions?: Map<WorkbenchThreadId, Error>;
  drainIndependent: boolean;
  owner: WorkbenchAgentMcpRuntimeOwner;
  policy: WorkbenchAgentMcpRuntimeDrainPolicy | null;
  /** Transcript references of the shell item this request runs; absent on requests the user cannot stop. */
  shellItemReferences?: readonly string[];
  /** Set once the shell waits for an expensive slot; kept after admission so the run timer starts there. */
  shellQueue?: { admittedAt: number | null; queuedAt: number; skip: AbortController };
  startedAt: number;
  /** Fixed for long waits; a shell is interruptible only while it waits in the expensive queue. */
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

type WorkbenchAgentMcpShellRunner = (
  run: WorkbenchShellRun, signal: AbortSignal, ticket?: WorkbenchCommandQueueTicket,
) => Promise<WorkbenchShellRunResult>;

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
  shellQueueListeners: Set<(threadId: WorkbenchThreadId) => void>;
  /** Each thread's current provider tool batch, in the order the model issued its calls. */
  toolBatches: Map<WorkbenchThreadId, WorkbenchAgentToolBatch>;
  batchTurnWaiters: Set<WorkbenchAgentBatchTurnWaiter>;
  /** Steers that arrived while the thread still ran a call; they interrupt its queued waits once that ends. */
  heldSteers: Map<WorkbenchThreadId, WorkbenchAgentHeldSteer>;
  ownerStates: WeakMap<WorkbenchAgentMcpRuntimeOwner, WorkbenchAgentMcpRuntimeOwnerState>;
  requestsByClient: Map<WorkbenchAgentMcpClientScope, Map<WorkbenchAgentMcpRequestId, WorkbenchAgentMcpRequestEntry>>;
}

/** `skipped`: an earlier call in the batch failed. `interrupted`: a steer arrived first. */
export type WorkbenchAgentBatchTurn = "ready" | "skipped" | "interrupted";

interface WorkbenchAgentToolBatch {
  /** The provider message that issued the calls; later parts of the same message extend the batch. */
  id: string;
  /** The provider's call ids, in issue order; MCP requests carry the same ids. */
  keys: string[];
  failed: Set<string>;
  settled: Set<string>;
}

interface WorkbenchAgentHeldSteer {
  reason: string;
  excludedToolNames: string[];
}

/** Process state outlives module generations: a held steer another generation stored in another shape is none. */
function readHeldSteer(stored: WorkbenchAgentHeldSteer | undefined) {
  return stored && typeof stored.reason === "string" && Array.isArray(stored.excludedToolNames) ? stored : null;
}

function isQueuedShell(entry: WorkbenchAgentMcpRequestEntry) {
  return entry.shellQueue !== undefined && entry.shellQueue.admittedAt === null;
}

interface WorkbenchAgentBatchTurnWaiter {
  threadId: WorkbenchThreadId | null;
  toolName: string;
  wake(): void;
  interrupt(): void;
}

interface WorkbenchAgentMcpRequestRegistrationOptions {
  owner: WorkbenchAgentMcpRuntimeOwner;
  policy?: WorkbenchAgentMcpRuntimeDrainPolicy;
  /** The shell's transcript item: its thread when known, and every reference that names the item. */
  shellItem?: { threadId?: WorkbenchThreadId; references: readonly string[] };
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

export interface WorkbenchAgentMcpShellQueueEntry {
  admittedAt: number | null;
  itemReferences: string[];
  queuedAt: number;
}

interface WorkbenchAgentMcpLegacyThreadWaitState {
  threadId: string;
  toolNames: string[];
}

const PROCESS_REGISTRY_KEY = Symbol.for("workbench.agentMcpRequestRegistry.v2");
/** A provider declares a batch as its message streams, which may trail the call's own request only briefly. */
const UNDECLARED_BATCH_GRACE_MS = 5_000;
const STEER_INTERRUPTION_KEY = Symbol.for("workbench.agentMcpSteerInterruption.v1");

function createWorkbenchAgentMcpSteerInterruption(reason: string) {
  const error = new Error(reason);
  Reflect.set(error, STEER_INTERRUPTION_KEY, true);
  return error;
}

export function isWorkbenchAgentMcpSteerInterruption(error: unknown) {
  return error instanceof Error && Reflect.get(error, STEER_INTERRUPTION_KEY) === true;
}

const USER_STOP_KEY = Symbol.for("workbench.agentMcpUserStop.v1");

export function isWorkbenchAgentMcpUserStop(error: unknown) {
  return error instanceof Error && Reflect.get(error, USER_STOP_KEY) === true;
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
    shellQueueListeners: new Set(),
    toolBatches: new Map(),
    batchTurnWaiters: new Set(),
    heldSteers: new Map(),
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
  state.shellQueueListeners.clear();
  state.toolBatches.clear();
  state.heldSteers.clear();
  for (const waiter of [...state.batchTurnWaiters]) waiter.wake();
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
  state.shellQueueListeners ??= new Set();
  state.toolBatches ??= new Map();
  state.batchTurnWaiters ??= new Set();
  state.heldSteers ??= new Map();
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
      ...(options.shellItem?.references.length ? { shellItemReferences: [...options.shellItem.references] } : {}),
      ...(options.shellItem?.threadId ? { workbenchThreadId: WorkbenchThreadIdSchema.parse(options.shellItem.threadId) } : {}),
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
        const deferredInterruption = entry.deferredSteerInterruptions?.get(workbenchThreadId);
        entry.deferredSteerInterruptions = undefined;
        // A queued shell may have been admitted since the steer; only a still-interruptible request takes it.
        if (deferredInterruption && entry.steerInterruptible && !entry.controller.signal.aborted) {
          entry.controller.abort(deferredInterruption);
        }
        if (entry.steerInterruptible && !entry.controller.signal.aborted) this.notifyThreadWaits(workbenchThreadId);
        if (entry.shellQueue) this.notifyShellQueue(workbenchThreadId);
      },
      ...(options.shellItem ? { shellQueue: this.shellQueueTicket(entry) } : {}),
      signal: entry.controller.signal,
      unregister: () => {
        if (requests.get(requestId) !== entry) return;
        requests.delete(requestId);
        if (requests.size === 0 && this.state.requestsByClient.get(clientScope) === requests) {
          this.state.requestsByClient.delete(clientScope);
        }
        if (entry.steerInterruptible && entry.workbenchThreadId) this.notifyThreadWaits(entry.workbenchThreadId);
        if (entry.shellQueue && entry.workbenchThreadId) this.notifyShellQueue(entry.workbenchThreadId);
        if (entry.workbenchThreadId) this.releaseHeldSteer(entry.workbenchThreadId);
      },
    };
  }

  /** Records a shell's expensive-queue wait; while it waits, the shell is a long wait that steers interrupt. */
  private shellQueueTicket(entry: WorkbenchAgentMcpRequestEntry): WorkbenchCommandQueueTicket {
    const skip = new AbortController();
    const changed = () => {
      if (!entry.workbenchThreadId) return;
      this.notifyThreadWaits(entry.workbenchThreadId);
      this.notifyShellQueue(entry.workbenchThreadId);
    };
    return {
      queued: at => {
        entry.shellQueue = { admittedAt: null, queuedAt: at, skip };
        entry.steerInterruptible = true;
        changed();
      },
      admitted: at => {
        if (entry.shellQueue) entry.shellQueue.admittedAt = at;
        entry.steerInterruptible = false;
        changed();
      },
      skip: skip.signal,
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
  async executeShell(run: WorkbenchShellRun, signal: AbortSignal, ticket?: WorkbenchCommandQueueTicket) {
    return await (await this.awaitSlot(() => this.state.shellRunner, this.state.shellRunnerWaiters, signal)).run(run, signal, ticket);
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
    for (const { threadId, toolName } of this.state.batchTurnWaiters) {
      if (threadId) toolNamesByThreadId.set(threadId, (toolNamesByThreadId.get(threadId) ?? new Set<string>()).add(toolName));
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

  /**
   * Record the calls one provider message issued, in order, before any of them runs. A message delivered in parts
   * extends its batch; another message replaces it, releasing anything still waiting on the old one.
   */
  declareToolBatch(threadId: WorkbenchThreadId, id: string, keys: readonly string[]) {
    const current = this.readToolBatch(this.state.toolBatches.get(threadId));
    if (current?.id === id) {
      current.keys.push(...keys.filter(key => !current.keys.includes(key)));
    } else {
      this.state.toolBatches.set(threadId, { id, keys: [...keys], failed: new Set(), settled: new Set() });
    }
    this.wakeBatchTurns();
  }

  /** The provider reported a batch call's result; a failure skips the serial calls after it. */
  settleToolUse(key: string, failed: boolean) {
    const found = this.findToolBatch(key);
    if (!found) return;
    found.batch.settled.add(key);
    if (failed) found.batch.failed.add(key);
    this.wakeBatchTurns();
  }

  /** The provider resolved every call of the thread's batch, or its turn ended; nothing waits on it any more. */
  endToolBatch(threadId: WorkbenchThreadId) {
    // The agent reads any held steer with the batch's results.
    this.state.heldSteers.delete(threadId);
    if (this.state.toolBatches.delete(threadId)) this.wakeBatchTurns();
  }

  /**
   * A serial call's long wait for its turn: every earlier call of its batch reported its result. Results arrive on
   * the provider's own stream, so waiting, not a point check, is what sees a failure that raced the call here. Waiting
   * covers a batch not yet declared; once its batch ends or is replaced the call runs, so no other thread or batch
   * can hold it, and earlier calls never wait on later ones.
   */
  async awaitBatchTurn(
    key: string, signal: AbortSignal, toolName = "shell", undeclaredGraceMs = UNDECLARED_BATCH_GRACE_MS,
  ): Promise<WorkbenchAgentBatchTurn> {
    let declared = false;
    // A call never declared, such as one the provider issued outside any observed message, must not wait forever.
    const grace = undeclaredGraceMs > 0 ? AbortSignal.timeout(undeclaredGraceMs) : null;
    for (;;) {
      signal.throwIfAborted();
      if (this.state.disposed) throw new Error("Workbench MCP request registry is disposed.");
      const found = this.findToolBatch(key);
      if (!found && (declared || !grace || grace.aborted)) return "ready";
      if (found) {
        declared = true;
        const earlier = found.batch.keys.slice(0, found.index);
        if (earlier.some(earlierKey => found.batch.failed.has(earlierKey))) return "skipped";
        if (earlier.every(earlierKey => found.batch.settled.has(earlierKey))) return "ready";
      }
      const threadId = found?.threadId ?? null;
      const interrupted = await new Promise<boolean>(resolve => {
        const finish = (value: boolean) => {
          this.state.batchTurnWaiters.delete(waiter);
          signal.removeEventListener("abort", abort);
          grace?.removeEventListener("abort", abort);
          if (threadId) this.notifyThreadWaits(threadId);
          resolve(value);
        };
        const abort = () => finish(false);
        const waiter: WorkbenchAgentBatchTurnWaiter = { threadId, toolName, wake: () => finish(false), interrupt: () => finish(true) };
        this.state.batchTurnWaiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
        if (!found) grace?.addEventListener("abort", abort, { once: true });
        if (threadId) this.notifyThreadWaits(threadId);
      });
      if (interrupted) return "interrupted";
    }
  }

  private findToolBatch(key: string) {
    for (const [threadId, stored] of this.state.toolBatches) {
      const batch = this.readToolBatch(stored);
      const index = batch?.keys.indexOf(key) ?? -1;
      if (batch && index >= 0) return { batch, index, threadId };
    }
    return null;
  }

  /** Process state outlives module generations: a batch another generation stored in another shape is no batch. */
  private readToolBatch(stored: WorkbenchAgentToolBatch | undefined) {
    return stored && Array.isArray(stored.keys) && stored.failed instanceof Set && stored.settled instanceof Set ? stored : null;
  }

  private wakeBatchTurns() {
    for (const waiter of [...this.state.batchTurnWaiters]) waiter.wake();
  }

  /** Every live shell of `threadId` that has waited in the expensive queue, oldest first. */
  readShellQueue(threadId: WorkbenchThreadId): WorkbenchAgentMcpShellQueueEntry[] {
    const queue: WorkbenchAgentMcpShellQueueEntry[] = [];
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (!entry.shellQueue || entry.workbenchThreadId !== threadId) continue;
        queue.push({
          admittedAt: entry.shellQueue.admittedAt,
          itemReferences: [...entry.shellItemReferences ?? []],
          queuedAt: entry.shellQueue.queuedAt,
        });
      }
    }
    return queue.sort((left, right) => left.queuedAt - right.queuedAt);
  }

  /** Calls `listener` with a thread whose shell queue changed; read it with `readShellQueue`. */
  subscribeShellQueue(listener: (threadId: WorkbenchThreadId) => void) {
    this.state.shellQueueListeners.add(listener);
    return () => { this.state.shellQueueListeners.delete(listener); };
  }

  private notifyShellQueue(threadId: WorkbenchThreadId) {
    for (const listener of this.state.shellQueueListeners) listener(threadId);
  }

  private threadWaitState(threadId: WorkbenchThreadId): WorkbenchAgentMcpThreadWaitState {
    const toolNames = new Set<string>();
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.steerInterruptible && entry.workbenchThreadId === threadId) toolNames.add(entry.toolName);
      }
    }
    for (const waiter of this.state.batchTurnWaiters) {
      if (waiter.threadId === threadId) toolNames.add(waiter.toolName);
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

  /**
   * Stop the running shell whose transcript item any of `references` names; aborting its signal kills the command.
   * A shell registered without thread identity matches on its references alone.
   */
  stopShell(threadId: WorkbenchThreadId, references: readonly string[]) {
    const entry = this.findLiveShell(threadId, references);
    if (!entry) return false;
    const error = new Error(`The user stopped this command after ${formatDuration(this.now() - entry.startedAt)}.`);
    Reflect.set(error, USER_STOP_KEY, true);
    entry.controller.abort(error);
    return true;
  }

  /** Start the matching shell now if it still waits in the expensive queue, as though it was never expensive. */
  startShellNow(threadId: WorkbenchThreadId, references: readonly string[]) {
    const queue = this.findLiveShell(threadId, references)?.shellQueue;
    if (!queue || queue.admittedAt !== null || queue.skip.signal.aborted) return false;
    queue.skip.abort();
    return true;
  }

  /** The unaborted shell whose transcript item any of `references` names; one without thread identity matches on references alone. */
  private findLiveShell(threadId: WorkbenchThreadId, references: readonly string[]) {
    const workbenchThreadId = WorkbenchThreadIdSchema.parse(threadId);
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.controller.signal.aborted || !entry.shellItemReferences?.some(reference => references.includes(reference))) continue;
        if (entry.workbenchThreadId && entry.workbenchThreadId !== workbenchThreadId) continue;
        return entry;
      }
    }
    return null;
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
        if (!entry.steerInterruptible || entry.controller.signal.aborted || excludedToolNames.includes(entry.toolName)) continue;
        if (entry.workbenchThreadId && entry.workbenchThreadId !== workbenchThreadId) continue;
        const interruption = createWorkbenchAgentMcpSteerInterruption(reason);
        if (!entry.workbenchThreadId) {
          (entry.deferredSteerInterruptions ??= new Map()).set(workbenchThreadId, interruption);
          continue;
        }
        if (isQueuedShell(entry)) continue;
        entry.controller.abort(interruption);
        interrupted += 1;
      }
    }
    if (this.hasRunningCall(workbenchThreadId)) {
      // The agent reads the steer only once its running calls end, so interrupting queued work now gains nothing.
      if (this.queuedWaits(workbenchThreadId, reason, excludedToolNames).length) {
        this.state.heldSteers.set(workbenchThreadId, { reason, excludedToolNames: [...excludedToolNames] });
      }
      return interrupted;
    }
    return interrupted + this.interruptQueuedWaits(workbenchThreadId, reason, excludedToolNames);
  }

  /** A queued shell or batch-turn wait of the thread, which a steer interrupts once nothing else of its thread runs. */
  private queuedWaits(threadId: WorkbenchThreadId, reason: string, excludedToolNames: readonly string[]) {
    const waits: Array<() => void> = [];
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.workbenchThreadId !== threadId || !isQueuedShell(entry) || entry.controller.signal.aborted) continue;
        if (excludedToolNames.includes(entry.toolName)) continue;
        waits.push(() => entry.controller.abort(createWorkbenchAgentMcpSteerInterruption(reason)));
      }
    }
    for (const waiter of this.state.batchTurnWaiters) {
      if (waiter.threadId === threadId && !excludedToolNames.includes(waiter.toolName)) waits.push(() => waiter.interrupt());
    }
    return waits;
  }

  private interruptQueuedWaits(threadId: WorkbenchThreadId, reason: string, excludedToolNames: readonly string[]) {
    const waits = this.queuedWaits(threadId, reason, excludedToolNames);
    for (const interrupt of waits) interrupt();
    return waits.length;
  }

  /** Whether a call of the thread is doing work a steer never interrupts, such as an admitted shell. */
  private hasRunningCall(threadId: WorkbenchThreadId) {
    for (const requests of this.state.requestsByClient.values()) {
      for (const entry of requests.values()) {
        if (entry.workbenchThreadId === threadId && !entry.steerInterruptible && !entry.controller.signal.aborted) return true;
      }
    }
    return false;
  }

  /** A held steer takes effect once the thread's last running call ends. */
  private releaseHeldSteer(threadId: WorkbenchThreadId) {
    const held = readHeldSteer(this.state.heldSteers.get(threadId));
    if (!held || this.hasRunningCall(threadId)) return;
    this.state.heldSteers.delete(threadId);
    this.interruptQueuedWaits(threadId, held.reason, held.excludedToolNames);
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

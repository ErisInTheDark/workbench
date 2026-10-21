/*
 * Exports:
 * - TransitionLeaseUpgradeError: a flow holding a read lease asked for a write lease on the same key.
 * - TransitionLeaseDeadlockError: waiting for a lease would close a wait cycle among leases.
 * - TransitionLeaseHandoff: live lock table and flow context passed to the next reload generation (shape changes must stay additive).
 * - TransitionLeaseSnapshot: per-key holders and waiters with kind, age and acquisition site, for diagnostics.
 * - default WorkbenchThreadTransitionCoordinator: deadlock-free, async-context-aware shared reads and exclusive writes by stable keys across reload generations.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type LeaseKind = "read" | "write";

/** One granted acquisition; it holds its key until its operation settles. */
interface LeaseScope {
  readonly key: string;
  readonly kind: LeaseKind;
  /** The lease scope the acquiring flow was already inside; that scope cannot settle before this one. */
  readonly parent: LeaseScope | null;
  readonly site: string;
  readonly since: number;
  released: boolean;
}

interface LeaseWaiter {
  readonly key: string;
  readonly kind: LeaseKind;
  readonly parent: LeaseScope | null;
  readonly site: string;
  readonly since: number;
  grant(): void;
  cancelWarning: () => void;
}

interface KeyState {
  readonly holders: Set<LeaseScope>;
  readonly queue: LeaseWaiter[];
}

/**
 * The live lock table and flow context, handed from one generation to the next. Both are the same objects, never copies:
 * a retiring generation's holders and waiters keep excluding, releasing and reentering against its successor.
 */
export interface TransitionLeaseHandoff {
  readonly version: 1;
  readonly states: Map<string, KeyState>;
  readonly context: AsyncLocalStorage<LeaseScope>;
}

export interface TransitionLeaseSnapshot {
  key: string;
  holders: Array<{ kind: LeaseKind; ageMs: number; site: string }>;
  waiters: Array<{ kind: LeaseKind; ageMs: number; site: string }>;
}

export class TransitionLeaseUpgradeError extends Error {
  constructor(key: string, held: string, requested: string) {
    super(`A flow holding a read lease on ${describeKey(key)} asked to write it, which can never be granted.\nheld at:\n${held}\nrequested at:\n${requested}`);
    this.name = "TransitionLeaseUpgradeError";
  }
}

export class TransitionLeaseDeadlockError extends Error {
  constructor(key: string, kind: LeaseKind, cycle: readonly string[]) {
    super(`Waiting for a ${kind} lease on ${describeKey(key)} would deadlock; refused.\n${cycle.join("\n")}`);
    this.name = "TransitionLeaseDeadlockError";
  }
}

/** A waiter still blocked after this long is reported once; it keeps waiting, because late completion is still correct. */
const LONG_WAIT_WARNING_MS = 60_000;
const SITE_FRAMES = 6;

function describeKey(key: string) {
  return JSON.stringify(key.replace(/\0/gu, " "));
}

function captureSite() {
  const lines = (new Error().stack ?? "").split("\n").slice(1).map(line => line.trim())
    .filter(line => !line.includes("WorkbenchThreadTransitionCoordinator"));
  return lines.slice(0, SITE_FRAMES).join("\n");
}

function conflicts(left: LeaseKind, right: LeaseKind) {
  return left === "write" || right === "write";
}

export default class WorkbenchThreadTransitionCoordinator {
  private readonly states: Map<string, KeyState>;
  private readonly context: AsyncLocalStorage<LeaseScope>;
  private readonly warn: (message: string) => void;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly now: () => number;

  constructor(options: {
    initialState?: TransitionLeaseHandoff;
    warn?: (message: string) => void;
    schedule?: (callback: () => void, delayMs: number) => () => void;
    now?: () => number;
  } = {}) {
    this.states = options.initialState?.states ?? new Map();
    this.context = options.initialState?.context ?? new AsyncLocalStorage();
    this.warn = options.warn ?? (message => console.warn(`[transition-leases] ${message.slice(0, 4000)}`));
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.now = options.now ?? Date.now;
  }

  async read<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withLease(key, "read", operation);
  }

  async run<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withLease(key, "write", operation);
  }

  /** An exclusive lease on a non-Git key, sharing the same deadlock-free lock graph. */
  async exclusive<TValue>(key: string, operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withLease(key, "write", operation);
  }

  async readMany<TValue>(keys: readonly string[], operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withMany(keys, (key, next) => this.read(key, next), operation);
  }

  async runMany<TValue>(keys: readonly string[], operation: () => Promise<TValue>): Promise<TValue> {
    return await this.withMany(keys, (key, next) => this.run(key, next), operation);
  }

  /** Whether the calling flow already holds the key, so it may reenter without waiting. */
  holds(key: string) {
    return this.heldKind(this.context.getStore() ?? null, key.trim()) !== null;
  }

  /** The live table for the next generation; this instance keeps serving its retiring dependants until they finish. */
  detachForReload(): TransitionLeaseHandoff {
    return { version: 1, states: this.states, context: this.context };
  }

  snapshot(): TransitionLeaseSnapshot[] {
    const now = this.now();
    return [...this.states].map(([key, state]) => ({
      key,
      holders: [...state.holders].map(scope => ({ kind: scope.kind, ageMs: now - scope.since, site: scope.site })),
      waiters: state.queue.map(waiter => ({ kind: waiter.kind, ageMs: now - waiter.since, site: waiter.site })),
    }));
  }

  private async withLease<TValue>(rawKey: string, kind: LeaseKind, operation: () => Promise<TValue>): Promise<TValue> {
    const key = rawKey.trim();
    if (!key) throw new Error("A transition coordination key is required.");
    const parent = this.context.getStore() ?? null;
    const held = this.heldScope(parent, key);
    if (held && (held.kind === "write" || kind === "read")) return await operation();
    if (held) throw new TransitionLeaseUpgradeError(key, held.site, captureSite());
    const scope = await this.acquire(key, kind, parent);
    try {
      return await this.context.run(scope, operation);
    } finally {
      this.release(scope);
    }
  }

  private async withMany<TValue>(
    keys: readonly string[],
    withKey: (key: string, operation: () => Promise<TValue>) => Promise<TValue>,
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const orderedKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    if (!orderedKeys.length) throw new Error("At least one transition coordination key is required.");
    const acquireAt = async (index: number): Promise<TValue> => index >= orderedKeys.length
      ? await operation()
      : await withKey(orderedKeys[index]!, async () => await acquireAt(index + 1));
    return await acquireAt(0);
  }

  private heldScope(scope: LeaseScope | null, key: string): LeaseScope | null {
    let found: LeaseScope | null = null;
    for (let cursor = scope; cursor; cursor = cursor.parent) {
      if (cursor.released || cursor.key !== key) continue;
      if (cursor.kind === "write") return cursor;
      found ??= cursor;
    }
    return found;
  }

  private heldKind(scope: LeaseScope | null, key: string) {
    return this.heldScope(scope, key)?.kind ?? null;
  }

  private state(key: string) {
    let state = this.states.get(key);
    if (!state) {
      state = { holders: new Set(), queue: [] };
      this.states.set(key, state);
    }
    return state;
  }

  private acquire(key: string, kind: LeaseKind, parent: LeaseScope | null) {
    const state = this.state(key);
    const site = captureSite();
    return new Promise<LeaseScope>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        key, kind, parent, site, since: this.now(),
        grant: () => {
          waiter.cancelWarning();
          const scope: LeaseScope = { key, kind, parent, site, since: this.now(), released: false };
          state.holders.add(scope);
          resolve(scope);
        },
        cancelWarning: () => undefined,
      };
      if (this.grantable(state, waiter, state.queue.length)) {
        waiter.grant();
        return;
      }
      const cycle = this.cycleThrough(this.blockers(state, waiter, state.queue.length), parent);
      if (cycle) {
        // A read only waits behind queued writers when no writer holds the key, so granting it now cannot conflict.
        if (kind === "read" && ![...state.holders].some(holder => holder.kind === "write")) {
          waiter.grant();
          return;
        }
        if (!state.holders.size && !state.queue.length) this.states.delete(key);
        reject(new TransitionLeaseDeadlockError(key, kind, [`requested at:\n${site}`, ...cycle]));
        return;
      }
      waiter.cancelWarning = this.schedule(() => this.reportLongWait(waiter), LONG_WAIT_WARNING_MS);
      state.queue.push(waiter);
    });
  }

  /** Whether a waiter at `position` in the queue may start: no conflicting holder and nothing ahead it must follow. */
  private grantable(state: KeyState, waiter: Pick<LeaseWaiter, "kind">, position: number) {
    if ([...state.holders].some(holder => conflicts(holder.kind, waiter.kind))) return false;
    const ahead = state.queue.slice(0, position);
    return waiter.kind === "read" ? !ahead.some(other => other.kind === "write") : ahead.length === 0;
  }

  /** What a waiter at `position` would wait for: conflicting holders, and the queued waiters it must follow. */
  private blockers(state: KeyState, waiter: Pick<LeaseWaiter, "kind">, position: number): Array<LeaseScope | LeaseWaiter> {
    const holders = [...state.holders].filter(holder => conflicts(holder.kind, waiter.kind));
    const ahead = state.queue.slice(0, position).filter(other => waiter.kind === "write" || other.kind === "write");
    return [...holders, ...ahead];
  }

  /**
   * Follows wait-for edges from `start`: a waiter waits for its blockers, and a holder cannot settle while any flow
   * inside it is waiting. Reaching a scope the requester is inside means waiting would close a cycle.
   */
  private cycleThrough(start: ReadonlyArray<LeaseScope | LeaseWaiter>, requester: LeaseScope | null): string[] | null {
    const inside = new Set<LeaseScope>();
    for (let cursor = requester; cursor; cursor = cursor.parent) if (!cursor.released) inside.add(cursor);
    if (!inside.size) return null;
    const waiters = [...this.states.values()].flatMap(state => state.queue);
    const visited = new Set<LeaseScope | LeaseWaiter>();
    const path: string[] = [];
    const visit = (node: LeaseScope | LeaseWaiter): boolean => {
      if (visited.has(node)) return false;
      visited.add(node);
      const isScope = "released" in node;
      path.push(`${isScope ? "held" : "waiting"} ${node.kind} ${describeKey(node.key)} at:\n${node.site}`);
      if (isScope && inside.has(node)) return true;
      const next: Array<LeaseScope | LeaseWaiter> = isScope
        ? waiters.filter(waiter => this.descends(waiter.parent, node))
        : this.blockers(this.states.get(node.key)!, node, this.states.get(node.key)!.queue.indexOf(node));
      for (const candidate of next) if (visit(candidate)) return true;
      path.pop();
      return false;
    };
    for (const node of start) if (visit(node)) return path;
    return null;
  }

  private descends(scope: LeaseScope | null, ancestor: LeaseScope) {
    for (let cursor = scope; cursor; cursor = cursor.parent) if (cursor === ancestor) return true;
    return false;
  }

  private release(scope: LeaseScope) {
    if (scope.released) return;
    scope.released = true;
    const state = this.states.get(scope.key);
    if (!state) return;
    state.holders.delete(scope);
    this.drain(scope.key, state);
  }

  private drain(key: string, state: KeyState) {
    while (state.queue.length && this.grantable(state, state.queue[0]!, 0)) {
      const waiter = state.queue.shift()!;
      waiter.grant();
      if (waiter.kind === "write") break;
    }
    if (!state.holders.size && !state.queue.length) this.states.delete(key);
  }

  private reportLongWait(waiter: LeaseWaiter) {
    const state = this.states.get(waiter.key);
    if (!state?.queue.includes(waiter)) return;
    const holders = [...state.holders].map(holder => `held ${holder.kind} for ${Math.round((this.now() - holder.since) / 1000)}s at:\n${holder.site}`);
    this.warn(`A ${waiter.kind} lease on ${describeKey(waiter.key)} has waited ${Math.round((this.now() - waiter.since) / 1000)}s.\nwaiting at:\n${waiter.site}\n${holders.join("\n") || "no holders"}`);
  }
}

/*
 * Exports:
 * - WorkbenchTranscriptReservoirDiagnostics: reachable retention and lifecycle counts for leak diagnostics.
 * - WorkbenchTranscriptReservoirLease: one browser's constant-size contiguous transcript demand.
 * - default WorkbenchTranscriptReservoir: own global serialized transcript retention, eviction, coalesced refill, fairness, and source generations.
 */
import type {
  WorkbenchTranscriptItemCursor,
  WorkbenchTranscriptItemEnvelope,
  WorkbenchTranscriptPrefetchRequest,
  WorkbenchTranscriptPrefetchResult,
  WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { compareWorkbenchTranscriptItemCursors as cursorOrder } from "workbench-shared/workbench/transcript/workbench-transcript-envelope";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** One refill fetches several browser pages ahead without one huge daemon read delaying first paint or evicting the reservoir. */
const REFILL_FRACTION = 8;

interface SerializedEnvelope {
  bytes: number;
  cursor: WorkbenchTranscriptItemCursor;
  itemId: string;
  json: string;
  turnId: string;
}

interface Block {
  bytes: number;
  catalogJson: string | null;
  envelopes: SerializedEnvelope[];
  lastAccess: number;
  thread: ThreadState;
}

interface ThreadState {
  blocks: Block[];
  daemonId: string;
  exhausted: boolean;
  generation: number;
  threadId: string;
}

interface PendingDemand {
  credit: number;
  promise: Promise<WorkbenchTranscriptPrefetchResult>;
  reject(error: Error): void;
  resolve(result: WorkbenchTranscriptPrefetchResult): void;
}

interface LeaseState {
  before?: WorkbenchTranscriptItemCursor;
  consumerId: string;
  daemonId: string;
  generation: number;
  pending: PendingDemand | null;
  released: boolean;
  threadId: string;
}

interface SourceState {
  cancellation: AbortController | null;
  daemonId: string;
  generation: number;
  inFlight: Promise<void> | null;
  intents: Set<string>;
  prefetch(request: WorkbenchTranscriptPrefetchRequest, signal: AbortSignal): Promise<WorkbenchTranscriptPrefetchResult>;
}

export interface WorkbenchTranscriptReservoirDiagnostics {
  blocks: number;
  inFlightSources: number;
  leases: number;
  pendingDemands: number;
  refillIntents: number;
  residentBytes: number;
  reachableBytes: number;
  sources: number;
  threads: number;
}

export interface WorkbenchTranscriptReservoirLease {
  demand(credit: number): Promise<WorkbenchTranscriptPrefetchResult>;
  release(): void;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : "Transcript refill failed.";
  return new Error(message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512));
}

function sourceChangedError() {
  return new Error("Transcript source generation changed.");
}

function releasedError() {
  return new Error("Transcript reservoir lease was released.");
}

export default class WorkbenchTranscriptReservoir {
  readonly #maxBytes: number;
  readonly #sources = new Map<string, SourceState>();
  readonly #threads = new Map<string, ThreadState>();
  readonly #leases = new Set<LeaseState>();
  #residentBytes = 0;
  #clock = 0;
  #disposed = false;

  constructor({ maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Transcript reservoir byte budget must be a positive integer.");
    }
    this.#maxBytes = maxBytes;
  }

  registerSource(input: {
    daemonId: string;
    generation: number;
    prefetch(
      request: WorkbenchTranscriptPrefetchRequest,
      signal: AbortSignal,
    ): Promise<WorkbenchTranscriptPrefetchResult>;
  }) {
    if (this.#disposed) throw new Error("Transcript reservoir is disposed.");
    const previous = this.#sources.get(input.daemonId);
    if (previous?.generation === input.generation) {
      previous.prefetch = input.prefetch;
      return () => {
        if (this.#sources.get(input.daemonId) === previous) this.#removeSource(previous, sourceChangedError());
      };
    }
    if (previous) this.#removeSource(previous, sourceChangedError());
    const source: SourceState = {
      cancellation: null,
      daemonId: input.daemonId,
      generation: input.generation,
      inFlight: null,
      intents: new Set(),
      prefetch: input.prefetch,
    };
    this.#sources.set(input.daemonId, source);
    return () => {
      if (this.#sources.get(input.daemonId) === source) this.#removeSource(source, sourceChangedError());
    };
  }

  open(input: {
    consumerId: string;
    daemonId: string;
    generation: number;
    threadId: string;
  }): WorkbenchTranscriptReservoirLease {
    if (this.#disposed) throw new Error("Transcript reservoir is disposed.");
    const source = this.#sources.get(input.daemonId);
    if (!source || source.generation !== input.generation) throw sourceChangedError();
    const lease: LeaseState = { ...input, pending: null, released: false };
    this.#leases.add(lease);
    return {
      demand: credit => this.#demand(lease, credit),
      release: () => this.#release(lease),
    };
  }

  seed(input: {
    daemonId: string;
    generation: number;
    replaceTurnIds?: readonly string[];
    result: WorkbenchTranscriptPrefetchResult;
    threadId: string;
  }) {
    if (this.#disposed) throw new Error("Transcript reservoir is disposed.");
    const source = this.#sources.get(input.daemonId);
    if (!source || source.generation !== input.generation) throw sourceChangedError();
    this.#insert(source, input.threadId, input.result, input.replaceTurnIds);
    this.#fulfil(source, input.threadId);
    if (this.#hasPendingDemand(source, input.threadId) && input.result.hasMore) {
      source.intents.add(input.threadId);
      this.#schedule(source);
    }
  }

  getDiagnostics(): WorkbenchTranscriptReservoirDiagnostics {
    const blocks = [...this.#threads.values()].flatMap(thread => thread.blocks);
    return {
      blocks: blocks.length,
      inFlightSources: [...this.#sources.values()].filter(source => source.inFlight !== null).length,
      leases: this.#leases.size,
      pendingDemands: [...this.#leases].filter(lease => lease.pending !== null).length,
      refillIntents: [...this.#sources.values()].reduce((sum, source) => sum + source.intents.size, 0),
      residentBytes: this.#residentBytes,
      reachableBytes: blocks.reduce((sum, block) => sum + block.bytes, 0),
      sources: this.#sources.size,
      threads: this.#threads.size,
    };
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const source of [...this.#sources.values()]) this.#removeSource(source, releasedError());
    for (const lease of [...this.#leases]) this.#release(lease);
    this.#threads.clear();
    this.#residentBytes = 0;
  }

  #demand(lease: LeaseState, credit: number) {
    if (lease.released || !this.#leases.has(lease)) return Promise.reject(releasedError());
    if (!Number.isSafeInteger(credit) || credit <= 0) {
      return Promise.reject(new Error("Transcript demand credit must be a positive integer."));
    }
    if (lease.pending) {
      lease.pending.credit = Math.max(lease.pending.credit, credit);
      this.#requestRefill(lease);
      return lease.pending.promise;
    }
    const cached = this.#readCached(lease, credit);
    if (cached) return Promise.resolve(cached);

    let resolve!: PendingDemand["resolve"];
    let reject!: PendingDemand["reject"];
    const promise = new Promise<WorkbenchTranscriptPrefetchResult>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    lease.pending = { credit, promise, reject, resolve };
    this.#requestRefill(lease);
    return promise;
  }

  #readCached(lease: LeaseState, credit: number) {
    const thread = this.#threads.get(this.#threadKey(lease.daemonId, lease.generation, lease.threadId));
    if (!thread) return null;
    const candidates = thread.blocks
      .flatMap(block => block.envelopes.map(envelope => ({ block, envelope })))
      .filter(({ envelope }) => !lease.before || cursorOrder(envelope.cursor, lease.before) < 0)
      .sort((left, right) => cursorOrder(left.envelope.cursor, right.envelope.cursor));
    if (candidates.length < credit && !thread.exhausted) return null;
    const selected = candidates.slice(-credit);
    for (const { block } of selected) block.lastAccess = ++this.#clock;
    const envelopes = selected.map(({ envelope }) => JSON.parse(envelope.json) as WorkbenchTranscriptItemEnvelope);
    if (envelopes[0]) lease.before = envelopes[0].cursor;
    const catalogBlock = [...thread.blocks].reverse().find(block => block.catalogJson !== null);
    const catalog = catalogBlock?.catalogJson
      ? JSON.parse(catalogBlock.catalogJson) as WorkbenchTranscriptSnapshot
      : null;
    return {
      catalog,
      envelopes,
      hasMore: candidates.length > selected.length || !thread.exhausted,
      retainedBytes: envelopes.reduce((sum, envelope) => sum + envelope.retainedBytes, 0),
    };
  }

  #requestRefill(lease: LeaseState) {
    const source = this.#sources.get(lease.daemonId);
    if (!source || source.generation !== lease.generation) {
      this.#rejectLease(lease, sourceChangedError());
      return;
    }
    source.intents.add(lease.threadId);
    this.#schedule(source);
  }

  #schedule(source: SourceState) {
    if (source.inFlight || this.#sources.get(source.daemonId) !== source) return;
    const threadId = source.intents.values().next().value as string | undefined;
    if (!threadId) return;
    source.intents.delete(threadId);
    if (!this.#hasPendingDemand(source, threadId)) {
      this.#schedule(source);
      return;
    }
    const key = this.#threadKey(source.daemonId, source.generation, threadId);
    const thread = this.#threads.get(key);
    const before = thread?.blocks
      .flatMap(block => block.envelopes)
      .sort((left, right) => cursorOrder(left.cursor, right.cursor))[0]?.cursor;
    const cancellation = new AbortController();
    source.cancellation = cancellation;
    let completed: WorkbenchTranscriptPrefetchResult | null = null;
    let failure: Error | null = null;
    const work = source.prefetch({
      ...(before ? { before } : {}),
      maxBytes: Math.max(1, Math.floor(this.#maxBytes / REFILL_FRACTION)),
      protocolVersion: 5,
      threadId,
    }, cancellation.signal).then(result => {
      if (this.#sources.get(source.daemonId) !== source || cancellation.signal.aborted) return;
      const inserted = this.#insert(source, threadId, result);
      if (!inserted && result.hasMore) throw new Error("Transcript refill made no cursor progress.");
      completed = result;
    }).catch(error => {
      if (this.#sources.get(source.daemonId) !== source || cancellation.signal.aborted) return;
      failure = boundedError(error);
    }).finally(() => {
      if (source.inFlight !== work) return;
      source.inFlight = null;
      source.cancellation = null;
      if (this.#sources.get(source.daemonId) !== source || cancellation.signal.aborted) return;
      if (failure) {
        this.#rejectThread(source, threadId, failure);
      } else if (completed) {
        this.#fulfil(source, threadId);
        if (this.#hasPendingDemand(source, threadId)) {
          if (completed.hasMore) source.intents.add(threadId);
          else this.#markExhausted(source, threadId);
          this.#fulfil(source, threadId);
        }
      }
      this.#schedule(source);
    });
    source.inFlight = work;
  }

  #insert(
    source: SourceState,
    threadId: string,
    result: WorkbenchTranscriptPrefetchResult,
    replaceTurnIds: readonly string[] = [],
  ) {
    const key = this.#threadKey(source.daemonId, source.generation, threadId);
    let thread = this.#threads.get(key);
    if (!thread) {
      thread = { blocks: [], daemonId: source.daemonId, exhausted: false, generation: source.generation, threadId };
      this.#threads.set(key, thread);
    }
    const replacedTurns = new Set(replaceTurnIds);
    if (replacedTurns.size) {
      for (const block of [...thread.blocks]) {
        const retained = block.envelopes.filter(envelope => !replacedTurns.has(envelope.turnId));
        if (retained.length === block.envelopes.length) continue;
        this.#residentBytes -= block.bytes;
        block.envelopes = retained;
        block.bytes = (block.catalogJson?.length ?? 0) * 2
          + retained.reduce((sum, envelope) => sum + envelope.bytes, 0);
        if (retained.length === 0) {
          block.catalogJson = null;
          block.bytes = 0;
          this.#removeBlock(block);
        } else {
          this.#residentBytes += block.bytes;
        }
      }
      this.#threads.set(key, thread);
    }
    thread.exhausted = !result.hasMore;
    if (result.envelopes.length === 0 && result.catalog === null) return false;
    const catalogJson = result.catalog === null ? null : JSON.stringify(result.catalog);
    const envelopes = result.envelopes.map(envelope => {
      const json = JSON.stringify(envelope);
      const metadataBytes = (envelope.itemId.length + envelope.cursor.itemId.length) * 2 + 24;
      const turnId = envelope.snapshot.rows.threadItems[0]?.turn_id;
      if (!turnId) throw new Error(`Transcript envelope ${envelope.itemId} has no root turn.`);
      return { bytes: json.length * 2 + metadataBytes, cursor: envelope.cursor, itemId: envelope.itemId, json, turnId };
    });
    const block: Block = {
      bytes: (catalogJson?.length ?? 0) * 2 + envelopes.reduce((sum, envelope) => sum + envelope.bytes, 0),
      catalogJson,
      envelopes,
      lastAccess: ++this.#clock,
      thread,
    };
    thread.blocks.push(block);
    this.#residentBytes += block.bytes;
    this.#evict(block);
    return result.envelopes.length > 0;
  }

  #evict(inserted: Block) {
    while (this.#residentBytes > this.#maxBytes) {
      const candidates = [...this.#threads.values()]
        .flatMap(thread => thread.blocks)
        .filter(block => block !== inserted)
        .sort((left, right) => left.lastAccess - right.lastAccess);
      const victim = candidates[0];
      if (!victim) break;
      this.#removeBlock(victim);
    }
  }

  #removeBlock(block: Block) {
    const index = block.thread.blocks.indexOf(block);
    if (index < 0) return;
    block.thread.blocks.splice(index, 1);
    this.#residentBytes -= block.bytes;
    this.#cleanupThread(block.thread);
  }

  #fulfil(source: SourceState, threadId: string) {
    for (const lease of this.#leases) {
      if (!lease.pending || lease.daemonId !== source.daemonId
        || lease.generation !== source.generation || lease.threadId !== threadId) continue;
      const result = this.#readCached(lease, lease.pending.credit);
      if (!result) continue;
      const pending = lease.pending;
      lease.pending = null;
      pending.resolve(result);
    }
    if (!this.#hasPendingDemand(source, threadId)) source.intents.delete(threadId);
  }

  #markExhausted(source: SourceState, threadId: string) {
    const thread = this.#threads.get(this.#threadKey(source.daemonId, source.generation, threadId));
    if (thread) thread.exhausted = true;
  }

  #hasPendingDemand(source: SourceState, threadId: string) {
    return [...this.#leases].some(lease => lease.pending
      && lease.daemonId === source.daemonId
      && lease.generation === source.generation
      && lease.threadId === threadId);
  }

  #rejectThread(source: SourceState, threadId: string, error: Error) {
    for (const lease of [...this.#leases]) {
      if (lease.daemonId === source.daemonId
        && lease.generation === source.generation
        && lease.threadId === threadId) this.#rejectLease(lease, error);
    }
    source.intents.delete(threadId);
  }

  #rejectLease(lease: LeaseState, error: Error) {
    const pending = lease.pending;
    lease.pending = null;
    pending?.reject(error);
  }

  #release(lease: LeaseState) {
    if (lease.released) return;
    lease.released = true;
    this.#leases.delete(lease);
    this.#rejectLease(lease, releasedError());
    const source = this.#sources.get(lease.daemonId);
    if (source && !this.#hasPendingDemand(source, lease.threadId)) source.intents.delete(lease.threadId);
    const thread = this.#threads.get(this.#threadKey(lease.daemonId, lease.generation, lease.threadId));
    if (thread) this.#cleanupThread(thread);
  }

  #removeSource(source: SourceState, error: Error) {
    source.cancellation?.abort(error);
    source.cancellation = null;
    source.intents.clear();
    this.#sources.delete(source.daemonId);
    for (const lease of [...this.#leases]) {
      if (lease.daemonId !== source.daemonId || lease.generation !== source.generation) continue;
      this.#rejectLease(lease, error);
      lease.released = true;
      this.#leases.delete(lease);
    }
    for (const thread of [...this.#threads.values()]) {
      if (thread.daemonId !== source.daemonId || thread.generation !== source.generation) continue;
      for (const block of [...thread.blocks]) this.#removeBlock(block);
      this.#threads.delete(this.#threadKey(thread.daemonId, thread.generation, thread.threadId));
    }
  }

  #cleanupThread(thread: ThreadState) {
    if (thread.blocks.length > 0) return;
    this.#threads.delete(this.#threadKey(thread.daemonId, thread.generation, thread.threadId));
  }

  #threadKey(daemonId: string, generation: number, threadId: string) {
    return `${daemonId}\u0000${generation}\u0000${threadId}`;
  }
}

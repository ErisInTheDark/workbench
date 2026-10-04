/*
 * Exports:
 * - default WorkbenchTranscriptIdentityController: index committed source identity for synchronous live projection, evicting threads idle past a window.
 */
import {
  TranscriptIdentityKeySchema,
  type ItemReference, type NativeItemId, type TranscriptIdentityKey,
  type WorkbenchItemId, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type {
  WorkbenchTranscriptIdentityDatabase,
  WorkbenchTranscriptItemIdentity,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
  WorkbenchTranscriptItemSource,
} from "./database/transcript/workbench-transcript-types";

/** Long enough that no admit→synchronous-map flow can straddle an eviction. */
const DEFAULT_IDLE_MS = 30 * 60_000;

interface ThreadReferences {
  references: Map<TranscriptIdentityKey, WorkbenchItemId>;
  touchedAt: number;
}

export default class WorkbenchTranscriptIdentityController {
  private disposed = false;
  /**
   * A cache of committed identity, not a source of truth: it starts empty on every daemon start and callers
   * re-admit or re-resolve on a miss, so threads idle past `idleMs` can drop out and behave as after a restart.
   */
  private readonly referencesByThread = new Map<WorkbenchThreadId, ThreadReferences>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private evictedAt: number;

  constructor(
    private readonly database: WorkbenchTranscriptIdentityDatabase,
    options: { now?: () => number; idleMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.evictedAt = this.now();
  }

  async admit(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]) {
    this.assertActive();
    const identities = await this.database.admitTranscriptItemIdentities(inputs);
    this.assertActive();
    return identities.map((identity) => this.remember(identity));
  }

  async resolve(input: WorkbenchTranscriptItemIdentityLookup) {
    this.assertActive();
    const identity = await this.database.resolveTranscriptItemIdentity(input);
    this.assertActive();
    return identity ? this.remember(identity) : null;
  }

  hasAdmitted(input: WorkbenchTranscriptItemIdentityAdmission): boolean {
    this.assertActive();
    const references = this.references(input.threadId);
    if (!references) return false;
    const keys = input.sources.map((source) => this.sourceKey(source));
    const itemId = input.itemId ?? references.get(keys[0]!);
    return itemId !== undefined && keys.length > 0 && keys.every((key) => references.get(key) === itemId);
  }

  itemIdForSource(threadId: WorkbenchThreadId, source: WorkbenchTranscriptItemSource): WorkbenchItemId {
    const itemId = this.findItemIdForSource(threadId, source);
    if (!itemId) throw new Error("Transcript source identity has not been admitted for live projection.");
    return itemId;
  }

  findItemIdForSource(threadId: WorkbenchThreadId, source: WorkbenchTranscriptItemSource) {
    this.assertActive();
    return this.references(threadId)?.get(this.sourceKey(source));
  }

  itemIdForReference(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: WorkbenchItemId | NativeItemId | ItemReference): WorkbenchItemId {
    const itemId = this.findItemIdForReference(threadId, turnId, reference);
    if (!itemId) throw new Error("Transcript item reference has not been admitted for live projection.");
    return itemId;
  }

  findItemIdForReference(threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, reference: WorkbenchItemId | NativeItemId | ItemReference) {
    this.assertActive();
    const references = this.references(threadId);
    const direct = references?.get(this.publicKey(reference));
    if (direct) return direct;
    const candidates = new Set(
      (["stable", "provisional", "client"] as const)
        .flatMap((kind) => references?.get(this.sourceKey({
          turnId,
          kind,
          reference,
          component: { kind: "item", index: 0 },
        })) ?? []),
    );
    if (candidates.size > 1) throw new Error("Transcript item reference has conflicting admitted identities.");
    return candidates.values().next().value;
  }

  dispose() {
    this.disposed = true;
    this.referencesByThread.clear();
  }

  private remember(identity: WorkbenchTranscriptItemIdentity) {
    const committed = Object.freeze({
      ...identity,
      sources: Object.freeze(identity.sources.map((source) => Object.freeze({
        ...source,
        component: source.component ? Object.freeze({ ...source.component }) : undefined,
      }))),
    });
    this.evictIdle();
    let references = this.references(committed.threadId);
    if (!references) {
      references = new Map();
      this.referencesByThread.set(committed.threadId, { references, touchedAt: this.now() });
    }
    references.set(this.publicKey(committed.itemId), committed.itemId);
    for (const source of committed.sources) references.set(this.sourceKey(source), committed.itemId);
    return committed;
  }

  /** Every lookup or admission keeps its thread warm. */
  private references(threadId: WorkbenchThreadId) {
    const entry = this.referencesByThread.get(threadId);
    if (!entry) return undefined;
    entry.touchedAt = this.now();
    return entry.references;
  }

  /** Sweeps at most once per window, so steady admissions stay O(1). */
  private evictIdle() {
    const now = this.now();
    if (now - this.evictedAt < Math.min(this.idleMs, 60_000)) return;
    this.evictedAt = now;
    for (const [threadId, entry] of this.referencesByThread) {
      if (now - entry.touchedAt >= this.idleMs) this.referencesByThread.delete(threadId);
    }
  }

  private publicKey(reference: string) {
    return TranscriptIdentityKeySchema.parse(JSON.stringify(["public", reference]));
  }

  private sourceKey(source: WorkbenchTranscriptItemSource) {
    return TranscriptIdentityKeySchema.parse(JSON.stringify([
      source.turnId,
      source.kind,
      source.reference,
      source.component?.kind ?? "item",
      source.component?.index ?? 0,
    ]));
  }

  private assertActive() {
    if (this.disposed) throw new Error("Transcript identity controller is disposed.");
  }
}

/*
 * Exports:
 * - default WorkbenchThreadIdentityController: expose database-owned identity, resolve Git arc owners, index admitted native bindings
 *   under merge relocations, report and settle sessions that must move, and reread threads whose stored ownership changed.
 */
import NativeLocationRelocations from "../database/thread-identity/native-location-relocations";
import {
  NativeThreadKeySchema, NativeThreadReferenceKeySchema, NativeTurnKeySchema, ProjectIdSchema, ThreadReferenceSchema,
  type NativeThreadId, type NativeThreadKey, type NativeThreadReferenceKey, type NativeTurnId,
  type NativeTurnKey, type ThreadReference, type TurnReference, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type {
  WorkbenchNativeThreadIdentity,
  WorkbenchThreadIdentityDatabase,
  WorkbenchThreadIdentityLookup,
  WorkbenchThreadIdentityMetadata,
  WorkbenchThreadIdentityRecord,
  WorkbenchThreadReplacementBinding,
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
  WorkbenchTurnIdentityRecord,
} from "../database/thread-identity/workbench-thread-identity-types";
import type { GitArcResolvedThreadIdentity } from "../lib/workbench/git/git-arc-thread-identity";
import type { WorkbenchHarness } from "workbench-shared/types";
import { WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";

export default class WorkbenchThreadIdentityController {
  private disposed = false;
  private readonly listeners = new Set<(threadId: WorkbenchThreadId) => void>();
  private readonly records = new Map<WorkbenchThreadIdentityLookup["threadId"], WorkbenchThreadIdentityRecord>();
  private readonly nativeOwners = new Map<NativeThreadKey, WorkbenchThreadId>();
  private readonly nativeReferences = new Map<NativeThreadReferenceKey, Map<string, WorkbenchNativeThreadIdentity>>();
  private readonly turns = new Map<WorkbenchTurnIdentityLookup["turnId"], WorkbenchTurnIdentityRecord>();
  private readonly nativeTurnOwners = new Map<NativeTurnKey, WorkbenchTurnId>();
  private relocations: NativeLocationRelocations;

  constructor(
    private readonly database: WorkbenchThreadIdentityDatabase,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.relocations = new NativeLocationRelocations([], platform);
  }

  async start() {
    this.assertActive();
    await this.loadRelocations();
    const records = await this.database.listThreadIdentities();
    this.assertActive();
    for (const record of records) this.remember(record);
  }

  /** `location` as merges relocated it; provider reports of a moved location and its destination name one place. */
  relocateLocation(location: string) {
    this.assertActive();
    return this.relocations.relocate(location);
  }

  /** Where the thread's provider session must move before its next turn, when a merge relocated its native location. */
  pendingRelocation(threadId: WorkbenchThreadId | ThreadReference) {
    this.assertActive();
    for (const binding of this.records.get(threadId)?.bindings ?? []) {
      const location = this.relocations.relocate(binding.nativeLocation);
      if (location !== binding.nativeLocation) return location;
    }
    return null;
  }

  /** Records that the thread's provider session now lives at `location`. */
  async settleRelocation(threadId: WorkbenchThreadId | ThreadReference, location: string) {
    this.assertActive();
    const record = this.knownThread(threadId);
    let settled = record;
    for (const harness of new Set(record.bindings.map(binding => binding.harness))) {
      settled = await this.database.settleThreadRelocation(record.threadId, harness, location);
      this.assertActive();
    }
    return this.remember(settled);
  }

  private async loadRelocations() {
    const relocations = await this.database.readNativeLocationRelocations();
    this.assertActive();
    this.relocations = new NativeLocationRelocations(relocations, this.platform);
    // Index keys fold relocations in, so every admitted binding re-keys under the new set.
    const records = [...this.records.values()];
    const turns = [...this.turns.values()];
    this.nativeOwners.clear();
    this.nativeReferences.clear();
    this.nativeTurnOwners.clear();
    this.records.clear();
    this.turns.clear();
    for (const record of records) this.remember(record, false);
    for (const turn of turns) this.rememberTurn(turn, false);
  }

  async observe(input: WorkbenchThreadIdentityMetadata) {
    return (await this.observeMany([input]))[0]!;
  }

  async observeMany(inputs: readonly WorkbenchThreadIdentityMetadata[]) {
    this.assertActive();
    if (!inputs.length) return [];
    const records = await this.database.observeThreadIdentities(inputs);
    this.assertActive();
    return records.map((record) => this.remember(record));
  }

  async resolve(input: WorkbenchThreadIdentityLookup) {
    this.assertActive();
    const known = this.records.get(input.threadId);
    if (known && (!input.projectId || input.projectId === known.projectId)) return known;
    // A different address may be a retained project alias. The database owns
    // that resolution and still rejects genuinely foreign project scopes.
    const record = await this.database.resolveThreadIdentity(input);
    this.assertActive();
    return record ? this.remember(record) : null;
  }

  /** Rereads threads whose project ownership changed underneath this cache, such as after a project merge. */
  async refreshThreads(threadIds: readonly WorkbenchThreadId[]) {
    await this.loadRelocations();
    for (const threadId of threadIds) {
      this.assertActive();
      const record = await this.database.resolveThreadIdentity({ threadId });
      this.assertActive();
      if (record) this.remember(record);
    }
  }

  async resolveNative(input: WorkbenchNativeThreadIdentity) {
    this.assertActive();
    const record = await this.database.resolveNativeThreadIdentity(input);
    this.assertActive();
    return record ? this.remember(record) : null;
  }

  async resolveGitArcThreadIdentity(input: {
    harness: WorkbenchHarness;
    projectId: string;
    repositoryRoot: string;
    threadId: string;
  }): Promise<GitArcResolvedThreadIdentity | null> {
    const identity = await this.resolve({
      harness: input.harness,
      projectId: ProjectIdSchema.parse(input.projectId),
      threadId: ThreadReferenceSchema.parse(input.threadId),
    });
    if (!identity) return null;
    const binding = this.gitArcBindings(identity, input.repositoryRoot).find(candidate => (
      candidate.harness === input.harness
    ));
    return binding ? { nativeThreadId: binding.nativeThreadId, threadId: identity.threadId } : null;
  }

  async reserveReplacementBinding(input: WorkbenchThreadReplacementBinding) {
    this.assertActive();
    if (!this.database.reserveReplacementBinding) throw new Error("Replacement binding reservation is unavailable.");
    const record = await this.database.reserveReplacementBinding(input);
    this.assertActive();
    return this.remember(record);
  }

  async releaseReplacementBinding(input: Omit<WorkbenchThreadReplacementBinding, "reservedAt">) {
    this.assertActive();
    if (!this.database.releaseReplacementBinding) throw new Error("Replacement binding release is unavailable.");
    const record = await this.database.releaseReplacementBinding(input);
    this.assertActive();
    return this.remember(record);
  }

  async resolveGitArcThreadOwner(input: {
    projectId: string;
    repositoryRoot: string;
    threadId: string;
  }): Promise<(GitArcResolvedThreadIdentity & { harness: WorkbenchHarness }) | null> {
    const identity = await this.resolve({
      projectId: ProjectIdSchema.parse(input.projectId),
      threadId: ThreadReferenceSchema.parse(input.threadId),
    });
    if (!identity) return null;
    const bindings = [...new Map(this.gitArcBindings(identity, input.repositoryRoot)
      .map(binding => [binding.harness, binding]))
      .values()];
    if (bindings.length > 1) throw new Error("The managed thread has multiple Git arc bindings for this repository.");
    const binding = bindings[0];
    return binding ? {
      harness: WorkbenchHarnessSchema.parse(binding.harness),
      nativeThreadId: binding.nativeThreadId,
      threadId: identity.threadId,
    } : null;
  }

  private gitArcBindings(identity: WorkbenchThreadIdentityRecord, repositoryRoot: string) {
    const location = this.relocations.key(repositoryRoot);
    return identity.bindings.filter(candidate => this.relocations.key(candidate.nativeLocation) === location);
  }

  async observeTurn(input: WorkbenchTurnIdentityMetadata) {
    return (await this.observeTurns([input]))[0]!;
  }

  async observeTurns(inputs: readonly WorkbenchTurnIdentityMetadata[]) {
    this.assertActive();
    if (!inputs.length) return [];
    const records = await this.database.observeTurnIdentities(inputs);
    this.assertActive();
    return records.map((record) => this.rememberTurn(record)).slice(0, inputs.length);
  }

  async resolveTurn(input: WorkbenchTurnIdentityLookup) {
    this.assertActive();
    const known = this.turns.get(input.turnId);
    if (known && known.threadId === input.threadId) return known;
    const record = await this.database.resolveTurnIdentity(input);
    this.assertActive();
    return record ? this.rememberTurn(record) : null;
  }

  workbenchTurnIdForNative(input: WorkbenchNativeThreadIdentity & { nativeTurnId: NativeTurnId }): WorkbenchTurnId {
    this.assertActive();
    const turnId = this.findNativeTurn(input)?.turnId;
    if (!turnId) throw new Error("Native turn identity has not been admitted for live projection.");
    return turnId;
  }

  findNativeTurn(input: WorkbenchNativeThreadIdentity & { nativeTurnId: NativeTurnId }) {
    this.assertActive();
    const id = this.nativeTurnOwners.get(this.nativeTurnKey(input));
    return id ? this.turns.get(id) : undefined;
  }

  findNativeThread(input: WorkbenchNativeThreadIdentity) {
    this.assertActive();
    const id = this.nativeOwners.get(this.nativeKey(input));
    return id ? this.records.get(id) : undefined;
  }

  knownTurn(turnId: WorkbenchTurnId | TurnReference): WorkbenchTurnIdentityRecord {
    this.assertActive();
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error("Workbench turn identity has not been admitted.");
    return turn;
  }

  workbenchIdForNative(input: WorkbenchNativeThreadIdentity) {
    this.assertActive();
    const threadId = this.nativeOwners.get(this.nativeKey(input));
    if (!threadId) throw new Error("Native thread identity has not been admitted for live projection.");
    return threadId;
  }

  knownNativeBinding(harness: string, nativeThreadId: NativeThreadId): WorkbenchNativeThreadIdentity {
    this.assertActive();
    const binding = this.findNativeBinding(harness, nativeThreadId);
    if (!binding) throw new Error("Native thread identity has not been admitted for live projection.");
    return binding;
  }

  findNativeBinding(harness: string, nativeThreadId: NativeThreadId) {
    this.assertActive();
    const bindings = this.nativeReferences.get(this.nativeReferenceKey(harness, nativeThreadId));
    if (!bindings?.size) return undefined;
    if (bindings.size !== 1) throw new Error("Native thread reference requires a location to resolve its owner.");
    return bindings.values().next().value!;
  }

  knownThread(threadId: WorkbenchThreadId | ThreadReference) {
    this.assertActive();
    const record = this.records.get(threadId);
    if (!record) throw new Error(`Workbench thread identity has not been admitted: ${threadId}`);
    return record;
  }

  findThread(threadId: WorkbenchThreadId | ThreadReference) {
    this.assertActive();
    return this.records.get(threadId) ?? null;
  }

  subscribe(listener: (threadId: WorkbenchThreadId) => void) {
    this.assertActive();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.records.clear();
    this.nativeOwners.clear();
    this.nativeReferences.clear();
    this.turns.clear();
    this.nativeTurnOwners.clear();
  }

  private remember(record: WorkbenchThreadIdentityRecord, notify = true) {
    this.assertActive();
    const previous = this.records.get(record.threadId);
    const committed = Object.freeze({
      ...record,
      bindings: Object.freeze(record.bindings.map((binding) => Object.freeze({ ...binding }))),
    });
    for (const binding of committed.bindings) {
      const owner = this.nativeOwners.get(this.nativeKey(binding));
      if (owner && owner !== committed.threadId) {
        throw new Error("Committed native thread identity has conflicting Workbench owners.");
      }
    }
    for (const binding of this.records.get(committed.threadId)?.bindings ?? []) {
      this.nativeOwners.delete(this.nativeKey(binding));
      const key = this.nativeReferenceKey(binding.harness, binding.nativeThreadId);
      const references = this.nativeReferences.get(key);
      references?.delete(this.relocations.key(binding.nativeLocation));
      if (!references?.size) this.nativeReferences.delete(key);
    }
    this.records.set(committed.threadId, committed);
    for (const binding of committed.bindings) {
      this.nativeOwners.set(this.nativeKey(binding), committed.threadId);
      // Provider events omit cwd. This index is published with the same committed
      // bindings, so event projection never performs a database lookup.
      const key = this.nativeReferenceKey(binding.harness, binding.nativeThreadId);
      const references = this.nativeReferences.get(key) ?? new Map<string, WorkbenchNativeThreadIdentity>();
      references.set(this.relocations.key(binding.nativeLocation), binding);
      this.nativeReferences.set(key, references);
    }
    if (notify && (!previous || previous.projectId !== committed.projectId
      || previous.bindings[0]?.harness !== committed.bindings[0]?.harness)) {
      for (const listener of this.listeners) {
        try { listener(committed.threadId); }
        catch (error) {
          console.error("Thread identity observer failed:", (error instanceof Error
            ? error.message : "Unknown observer failure").replace(/[\u0000-\u001f]/gu, "").slice(0, 512));
        }
      }
    }
    return committed;
  }

  private rememberTurn(record: WorkbenchTurnIdentityRecord, bindThread = true) {
    this.assertActive();
    const committed = Object.freeze({ ...record, native: Object.freeze({ ...record.native }) });
    if (committed.native.nativeTurnId !== null) {
      const key = this.nativeTurnKey(committed.native);
      const owner = this.nativeTurnOwners.get(key);
      if (owner && owner !== committed.turnId) throw new Error("Committed native turn has conflicting Workbench owners.");
      this.nativeTurnOwners.set(key, committed.turnId);
    }
    this.turns.set(committed.turnId, committed);
    const thread = this.records.get(committed.threadId);
    if (thread && bindThread) {
      const key = this.nativeKey(committed.native);
      const previous = thread.bindings.find((binding) => this.nativeKey(binding) === key);
      this.remember({
        ...thread,
        bindings: [
          ...thread.bindings.filter((binding) => this.nativeKey(binding) !== key),
          {
            harness: committed.native.harness,
            nativeLocation: committed.native.nativeLocation,
            nativeThreadId: committed.native.nativeThreadId,
            pending: false,
            turnIndex: Math.max(previous?.turnIndex ?? -1, committed.turnIndex),
          },
        ].sort((left, right) => Number(right.pending) - Number(left.pending)
          || (right.turnIndex ?? -1) - (left.turnIndex ?? -1)),
      });
    }
    return committed;
  }

  private nativeReferenceKey(harness: string, nativeThreadId: NativeThreadId) {
    return NativeThreadReferenceKeySchema.parse(JSON.stringify([harness, nativeThreadId]));
  }

  private nativeTurnKey(input: WorkbenchNativeThreadIdentity & { nativeTurnId: NativeTurnId | null }) {
    return NativeTurnKeySchema.parse(JSON.stringify([input.harness, this.relocations.key(input.nativeLocation), input.nativeThreadId, input.nativeTurnId]));
  }

  private nativeKey(input: WorkbenchNativeThreadIdentity) {
    return NativeThreadKeySchema.parse(JSON.stringify([input.harness, this.relocations.key(input.nativeLocation), input.nativeThreadId]));
  }

  private assertActive() {
    if (this.disposed) throw new Error("Workbench thread identity controller is disposed.");
  }
}

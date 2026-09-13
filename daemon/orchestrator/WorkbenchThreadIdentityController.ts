/*
 * Exports:
 * - default WorkbenchThreadIdentityController: expose database-owned identity and index admitted native bindings for live events.
 */
import { nativeLocationKey } from "./database/thread-identity/native-location-key";
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
  WorkbenchTurnIdentityLookup,
  WorkbenchTurnIdentityMetadata,
  WorkbenchTurnIdentityRecord,
} from "./database/thread-identity/workbench-thread-identity-types";
import type { GitArcResolvedThreadIdentity } from "../lib/workbench/git/git-arc-thread-identity";
import type { WorkbenchHarness } from "workbench-shared/types";

export default class WorkbenchThreadIdentityController {
  private disposed = false;
  private readonly records = new Map<WorkbenchThreadIdentityLookup["threadId"], WorkbenchThreadIdentityRecord>();
  private readonly nativeOwners = new Map<NativeThreadKey, WorkbenchThreadId>();
  private readonly nativeReferences = new Map<NativeThreadReferenceKey, Map<string, WorkbenchNativeThreadIdentity>>();
  private readonly turns = new Map<WorkbenchTurnIdentityLookup["turnId"], WorkbenchTurnIdentityRecord>();
  private readonly nativeTurnOwners = new Map<NativeTurnKey, WorkbenchTurnId>();

  constructor(
    private readonly database: WorkbenchThreadIdentityDatabase,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async start() {
    this.assertActive();
    const records = await this.database.listThreadIdentities();
    this.assertActive();
    for (const record of records) this.remember(record);
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
    if (known) {
      if (input.projectId && input.projectId !== known.projectId) throw new Error("Workbench thread does not belong to the requested project.");
      return known;
    }
    const record = await this.database.resolveThreadIdentity(input);
    this.assertActive();
    return record ? this.remember(record) : null;
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
    const location = nativeLocationKey(input.repositoryRoot, this.platform);
    const binding = identity.bindings.find(candidate => (
      candidate.harness === input.harness
      && nativeLocationKey(candidate.nativeLocation, this.platform) === location
    ));
    return binding ? { nativeThreadId: binding.nativeThreadId, threadId: identity.threadId } : null;
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

  dispose() {
    this.disposed = true;
    this.records.clear();
    this.nativeOwners.clear();
    this.nativeReferences.clear();
    this.turns.clear();
    this.nativeTurnOwners.clear();
  }

  private remember(record: WorkbenchThreadIdentityRecord) {
    this.assertActive();
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
      references?.delete(nativeLocationKey(binding.nativeLocation, this.platform));
      if (!references?.size) this.nativeReferences.delete(key);
    }
    this.records.set(committed.threadId, committed);
    for (const binding of committed.bindings) {
      this.nativeOwners.set(this.nativeKey(binding), committed.threadId);
      // Provider events omit cwd. This index is published with the same committed
      // bindings, so event projection never performs a database lookup.
      const key = this.nativeReferenceKey(binding.harness, binding.nativeThreadId);
      const references = this.nativeReferences.get(key) ?? new Map<string, WorkbenchNativeThreadIdentity>();
      references.set(nativeLocationKey(binding.nativeLocation, this.platform), binding);
      this.nativeReferences.set(key, references);
    }
    return committed;
  }

  private rememberTurn(record: WorkbenchTurnIdentityRecord) {
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
    if (thread) {
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
    return NativeTurnKeySchema.parse(JSON.stringify([input.harness, nativeLocationKey(input.nativeLocation, this.platform), input.nativeThreadId, input.nativeTurnId]));
  }

  private nativeKey(input: WorkbenchNativeThreadIdentity) {
    return NativeThreadKeySchema.parse(JSON.stringify([input.harness, nativeLocationKey(input.nativeLocation, this.platform), input.nativeThreadId]));
  }

  private assertActive() {
    if (this.disposed) throw new Error("Workbench thread identity controller is disposed.");
  }
}

/*
 * Keywords: thread identity, native adapter, reload, live lookup.
 * Exports:
 * - default WorkbenchThreadIdentityController: expose database-owned identity and index admitted native bindings for live events.
 */
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

export default class WorkbenchThreadIdentityController {
  private disposed = false;
  private readonly records = new Map<string, WorkbenchThreadIdentityRecord>();
  private readonly nativeOwners = new Map<string, string>();
  private readonly nativeReferences = new Map<string, Map<string, WorkbenchNativeThreadIdentity>>();
  private readonly turns = new Map<string, WorkbenchTurnIdentityRecord>();
  private readonly nativeTurnOwners = new Map<string, string>();

  constructor(private readonly database: WorkbenchThreadIdentityDatabase) {}

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

  workbenchTurnIdForNative(input: WorkbenchNativeThreadIdentity & { nativeTurnId: string }): string {
    this.assertActive();
    const turnId = this.findNativeTurn(input)?.turnId;
    if (!turnId) throw new Error("Native turn identity has not been admitted for live projection.");
    return turnId;
  }

  findNativeTurn(input: WorkbenchNativeThreadIdentity & { nativeTurnId: string }) {
    this.assertActive();
    const id = this.nativeTurnOwners.get(this.nativeTurnKey(input));
    return id ? this.turns.get(id) : undefined;
  }

  findNativeThread(input: WorkbenchNativeThreadIdentity) {
    this.assertActive();
    const id = this.nativeOwners.get(this.nativeKey(input));
    return id ? this.records.get(id) : undefined;
  }

  knownTurn(turnId: string): WorkbenchTurnIdentityRecord {
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

  knownNativeBinding(harness: string, nativeThreadId: string): WorkbenchNativeThreadIdentity {
    this.assertActive();
    const binding = this.findNativeBinding(harness, nativeThreadId);
    if (!binding) throw new Error("Native thread identity has not been admitted for live projection.");
    return binding;
  }

  findNativeBinding(harness: string, nativeThreadId: string) {
    this.assertActive();
    const bindings = this.nativeReferences.get(JSON.stringify([harness, nativeThreadId]));
    if (!bindings?.size) return undefined;
    if (bindings.size !== 1) throw new Error("Native thread reference requires a location to resolve its owner.");
    return bindings.values().next().value!;
  }

  knownThread(threadId: string) {
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
      const key = JSON.stringify([binding.harness, binding.nativeThreadId]);
      const references = this.nativeReferences.get(key);
      references?.delete(binding.nativeLocation);
      if (!references?.size) this.nativeReferences.delete(key);
    }
    this.records.set(committed.threadId, committed);
    for (const binding of committed.bindings) {
      this.nativeOwners.set(this.nativeKey(binding), committed.threadId);
      // Provider events omit cwd. This index is published with the same committed
      // bindings, so event projection never performs a database lookup.
      const key = JSON.stringify([binding.harness, binding.nativeThreadId]);
      const references = this.nativeReferences.get(key) ?? new Map<string, WorkbenchNativeThreadIdentity>();
      references.set(binding.nativeLocation, binding);
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

  private nativeTurnKey(input: WorkbenchNativeThreadIdentity & { nativeTurnId: string | null }) {
    return JSON.stringify([input.harness, input.nativeLocation, input.nativeThreadId, input.nativeTurnId]);
  }

  private nativeKey(input: WorkbenchNativeThreadIdentity) {
    return JSON.stringify([input.harness, input.nativeLocation, input.nativeThreadId]);
  }

  private assertActive() {
    if (this.disposed) throw new Error("Workbench thread identity controller is disposed.");
  }
}

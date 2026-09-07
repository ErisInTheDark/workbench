/*
 * Keywords: transcript, structural admission, live delta, identity, disposal.
 * Exports:
 * - default WorkbenchTranscriptIdentityController: index committed source identity for synchronous live projection.
 */
import type {
  WorkbenchTranscriptIdentityDatabase,
  WorkbenchTranscriptItemIdentity,
  WorkbenchTranscriptItemIdentityAdmission,
  WorkbenchTranscriptItemIdentityLookup,
  WorkbenchTranscriptItemSource,
} from "./database/transcript/workbench-transcript-types";

export default class WorkbenchTranscriptIdentityController {
  private disposed = false;
  private readonly referencesByThread = new Map<string, Map<string, string>>();

  constructor(private readonly database: WorkbenchTranscriptIdentityDatabase) {}

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
    const references = this.referencesByThread.get(input.threadId);
    if (!references) return false;
    const keys = [
      ...input.sources.map((source) => this.sourceKey(source)),
      ...input.legacyAliases.map(({ turnId, alias }) => this.sourceKey({ turnId, kind: "legacy", sourceId: alias })),
    ];
    const itemId = input.itemId ?? references.get(keys[0]!);
    return itemId !== undefined && keys.length > 0 && keys.every((key) => references.get(key) === itemId);
  }

  itemIdForSource(threadId: string, source: WorkbenchTranscriptItemSource): string {
    const itemId = this.findItemIdForSource(threadId, source);
    if (!itemId) throw new Error("Transcript source identity has not been admitted for live projection.");
    return itemId;
  }

  findItemIdForSource(threadId: string, source: WorkbenchTranscriptItemSource) {
    this.assertActive();
    return this.referencesByThread.get(threadId)?.get(this.sourceKey(source));
  }

  itemIdForReference(threadId: string, turnId: string, reference: string): string {
    const itemId = this.findItemIdForReference(threadId, turnId, reference);
    if (!itemId) throw new Error("Transcript item reference has not been admitted for live projection.");
    return itemId;
  }

  findItemIdForReference(threadId: string, turnId: string, reference: string) {
    this.assertActive();
    const references = this.referencesByThread.get(threadId);
    const direct = references?.get(JSON.stringify(["public", reference]));
    if (direct) return direct;
    const candidates = new Set(
      (["stable", "provisional", "client", "legacy"] as const)
        .flatMap((kind) => references?.get(this.sourceKey({ turnId, kind, sourceId: reference })) ?? []),
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
      sources: Object.freeze(identity.sources.map((source) => Object.freeze({ ...source }))),
      legacyAliases: Object.freeze(identity.legacyAliases.map((alias) => Object.freeze({ ...alias }))),
    });
    let references = this.referencesByThread.get(committed.threadId);
    if (!references) {
      references = new Map();
      this.referencesByThread.set(committed.threadId, references);
    }
    references.set(JSON.stringify(["public", committed.itemId]), committed.itemId);
    for (const source of committed.sources) references.set(this.sourceKey(source), committed.itemId);
    for (const legacy of committed.legacyAliases) {
      references.set(this.sourceKey({ turnId: legacy.turnId, kind: "legacy", sourceId: legacy.alias }), committed.itemId);
      const publicKey = JSON.stringify(["public", legacy.alias]);
      if (references.has(publicKey)) references.set(publicKey, committed.itemId);
    }
    return committed;
  }

  private sourceKey(source: { turnId: string; kind: WorkbenchTranscriptItemSource["kind"] | "legacy"; sourceId: string }) {
    return JSON.stringify([source.turnId, source.kind, source.sourceId]);
  }

  private assertActive() {
    if (this.disposed) throw new Error("Transcript identity controller is disposed.");
  }
}

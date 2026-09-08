/*
 * Keywords: transcript, native boundary, identity, recording, steer, client correlation.
 * Exports:
 * - mapNativeTranscriptObservation: translate admitted native references for canonical recording.
 * - admitNativeTranscriptObservations: admit missing structural identities before publication or body recording.
 * - NativeTranscriptIdentityOwners: database-owned admission and committed projection ports.
 */
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { getCodexItemIdentityKind } from "workbench-shared/codex/thread-item-source";
import { z } from "zod";
import { resolveSteerTranscriptSourceId } from "workbench-shared/workbench/thread/thread-steer-history";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { WorkbenchNativeThreadIdentity } from "./database/thread-identity/workbench-thread-identity-types";
import type { WorkbenchTranscriptAtomicObservation, WorkbenchTranscriptObservation, WorkbenchTranscriptItemIdentityAdmission, WorkbenchTranscriptItemSource } from "./database/transcript/workbench-transcript-types";
import { mapProviderThreadItem, type WorkbenchProviderIdentityOwners } from "./thread-identity-provider-mapping";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";

type IdentityOwners = WorkbenchProviderIdentityOwners & {
  threads: Pick<WorkbenchThreadIdentityController, "knownTurn">;
  items: Pick<WorkbenchTranscriptIdentityController, "itemIdForReference">;
};
export interface NativeTranscriptIdentityOwners {
  threads: WorkbenchThreadIdentityController;
  items: WorkbenchTranscriptIdentityController;
}
type CatalogObservation = Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" | "turn" }>;
type ObservationMappers = {
  [Kind in WorkbenchTranscriptObservation["kind"]]:
    (input: Extract<WorkbenchTranscriptObservation, { kind: Kind }>) => Extract<WorkbenchTranscriptObservation, { kind: Kind }>;
};

function steerSources(entry: WorkbenchSteerHistoryEntry, turnId: string): WorkbenchTranscriptItemSource[] {
  if (entry.status === "sent") {
    const sources: WorkbenchTranscriptItemSource[] = [];
    if (entry.canonicalItemId) {
      sources.push({ turnId, sourceId: entry.canonicalItemId, kind: getCodexItemIdentityKind({ id: entry.canonicalItemId }) });
    }
    if (entry.clientUserMessageId) {
      sources.push({ turnId, sourceId: entry.clientUserMessageId, kind: "client" });
    }
    if (sources.length) return sources;
  }
  return [{ turnId, sourceId: resolveSteerTranscriptSourceId(entry), kind: "stable" }];
}

function steerAttemptReference(entry: WorkbenchSteerHistoryEntry, publicItemId?: string) {
  // The queued attempt ID is not evidence that it owns the delivered provider message.
  return entry.status === "sent" && (entry.canonicalItemId || entry.clientUserMessageId)
    ? undefined
    : publicItemId ?? entry.itemId ?? undefined;
}

export async function admitNativeTranscriptObservations(
  owners: NativeTranscriptIdentityOwners,
  observations: readonly WorkbenchTranscriptObservation[],
) {
  const facts = observations.flatMap<WorkbenchTranscriptAtomicObservation | Extract<WorkbenchTranscriptObservation, { kind: "captureGap" }>>((observation) => {
    switch (observation.kind) {
      case "canonicalWindow":
      case "providerTurnScope": return observation.observations;
      case "turnCatalog": return observation.catalog;
      case "usageWindow": return [...observation.catalog, ...observation.observations];
      default: return [observation];
    }
  });
  const turns = facts.filter((fact) => fact.kind === "turn");
  await owners.threads.observeTurns(turns.filter((fact) => fact.nativeTurnId !== null
    && !owners.threads.findNativeTurn({
      harness: fact.harnessId, nativeLocation: fact.nativeLocation,
      nativeThreadId: fact.nativeThreadId, nativeTurnId: fact.nativeTurnId,
    })).map((fact) => ({
      ...fact,
      threadId: owners.threads.workbenchIdForNative({
        harness: fact.harnessId, nativeLocation: fact.nativeLocation, nativeThreadId: fact.nativeThreadId,
      }),
    })));
  const items: WorkbenchTranscriptItemIdentityAdmission[] = [];
  for (const fact of facts) {
    if (fact.kind !== "item" && fact.kind !== "questionnaire" && fact.kind !== "steer") continue;
    const nativeThreadId = fact.kind === "item" ? fact.threadId : fact.entry.threadId;
    const nativeTurnId = fact.kind === "item" ? fact.turnId : fact.entry.turnId;
    const native = owners.threads.knownNativeBinding("codex", nativeThreadId);
    const threadId = owners.threads.workbenchIdForNative(native);
    const turnId = owners.threads.workbenchTurnIdForNative({ ...native, nativeTurnId });
    const sourceId = fact.kind === "item" ? fact.item.id
      : fact.kind === "questionnaire" ? resolveQuestionnaireHistoryItemId(fact.entry)
        : resolveSteerTranscriptSourceId(fact.entry);
    const sources: WorkbenchTranscriptItemSource[] = fact.kind === "steer" ? steerSources(fact.entry, turnId) : [
      { turnId, sourceId, kind: fact.kind === "item" ? getCodexItemIdentityKind(fact.item) : "stable" },
      ...(fact.kind === "item" && fact.item.type === "userMessage" && fact.item.clientId
        ? [{ turnId, kind: "client" as const, sourceId: fact.item.clientId }] : []),
    ];
    const reference = fact.kind === "item" ? fact.publicItemId
      : fact.kind === "steer" ? steerAttemptReference(fact.entry, fact.publicItemId)
        : fact.publicItemId ?? fact.entry.itemId ?? undefined;
    const itemId = z.uuid().safeParse(reference).success ? reference : undefined;
    const known = owners.items.findItemIdForSource(threadId, sources[0]!);
    if (known && (!itemId || itemId === known)
      && sources.every((source) => owners.items.findItemIdForSource(threadId, source) === known)) continue;
    items.push({
      threadId, ...(itemId ? { itemId } : {}),
      sources,
      legacyAliases: fact.kind === "item"
        ? (fact.timeline?.aliases ?? []).map((alias) => ({ turnId, alias })) : [],
    });
  }
  if (items.length) await owners.items.admit(items);
}

export function mapNativeTranscriptObservation(
  owners: IdentityOwners,
  native: WorkbenchNativeThreadIdentity,
  observation: WorkbenchTranscriptObservation,
): WorkbenchTranscriptObservation {
  const threadId = (source: string) => owners.threads.workbenchIdForNative({ ...native, nativeThreadId: source });
  const turnId = (thread: string, source: string) => owners.threads.workbenchTurnIdForNative({
    ...native, nativeThreadId: thread, nativeTurnId: source,
  });
  const itemId = (thread: string, turn: string, source: string) => owners.items.itemIdForReference(
    threadId(thread), turnId(thread, turn), source,
  );
  // Each discriminator selects its matching typed handler; only the indexed call needs narrowing.
  const mapAtomic = (input: WorkbenchTranscriptAtomicObservation) => mappings[input.kind](input as never);
  const mapCatalog = (input: CatalogObservation) => mappings[input.kind](input as never);
  const mappings: ObservationMappers = {
    thread: (input) => ({ ...input, threadId: threadId(input.threadId) }),
    turn: (input) => {
      const id = input.nativeTurnId === null ? input.turnId : turnId(input.threadId, input.nativeTurnId);
      const admitted = owners.threads.knownTurn(id);
      if (admitted.threadId !== threadId(input.threadId)) throw new Error("Transcript turn changed its admitted owner.");
      return {
        ...input, threadId: admitted.threadId, turnId: id, turnIndex: admitted.turnIndex,
        nativeLocation: admitted.native.nativeLocation,
      };
    },
    turnUsageContext: (input) => ({
      ...input, threadId: threadId(input.threadId), turnId: turnId(input.threadId, input.turnId),
    }),
    turnTokenUsage: (input) => ({
      ...input, threadId: threadId(input.threadId), turnId: turnId(input.threadId, input.turnId),
    }),
    item: (input) => {
      const mapped = mapProviderThreadItem(owners, {
        ...native, nativeThreadId: input.threadId, nativeTurnId: input.turnId,
      }, input.item);
      return {
        ...input, threadId: threadId(input.threadId), turnId: turnId(input.threadId, input.turnId),
        publicItemId: mapped.id,
        item: { ...mapped, id: input.item.id },
        ...(input.timeline ? { timeline: { ...input.timeline, itemId: mapped.id } } : {}),
      };
    },
    questionnaire: (input) => {
      const entry = input.entry;
      const id = itemId(entry.threadId, entry.turnId, input.publicItemId ?? resolveQuestionnaireHistoryItemId(entry));
      return {
        ...input, publicItemId: id,
        entry: {
          ...entry, threadId: threadId(entry.threadId), turnId: turnId(entry.threadId, entry.turnId), itemId: id,
          // Compatibility has already supplied list order; anchors have no durable authority.
          insertAfterItemId: null, insertAfterItemIndex: null,
        },
      };
    },
    steer: (input) => {
      const entry = input.entry;
      const ownerThreadId = threadId(entry.threadId);
      const ownerTurnId = turnId(entry.threadId, entry.turnId);
      const reference = steerAttemptReference(entry, input.publicItemId);
      const id = reference
        ? itemId(entry.threadId, entry.turnId, reference)
        : owners.items.itemIdForSource(ownerThreadId, steerSources(entry, ownerTurnId)[0]!);
      return {
        ...input, publicItemId: id,
        entry: {
          ...entry, threadId: ownerThreadId, turnId: ownerTurnId, itemId: id,
          canonicalItemId: entry.canonicalItemId === null ? null : owners.items.itemIdForSource(ownerThreadId, {
            turnId: ownerTurnId, sourceId: entry.canonicalItemId, kind: getCodexItemIdentityKind({ id: entry.canonicalItemId }),
          }),
        },
      };
    },
    browse: (input) => ({
      ...input,
      entry: {
        ...input.entry,
        threadId: threadId(input.entry.threadId), turnId: turnId(input.entry.threadId, input.entry.turnId),
        commandItemId: input.entry.commandItemId === null ? null
          : itemId(input.entry.threadId, input.entry.turnId, input.entry.commandItemId),
      },
    }),
    nativeEvidence: (input) => {
      if (input.threadId === null) return input;
      if (input.itemId !== null && input.turnId === null) throw new Error("Transcript item evidence requires an owning turn.");
      return {
        ...input, threadId: threadId(input.threadId),
        turnId: input.turnId === null ? null : turnId(input.threadId, input.turnId),
        itemId: input.itemId === null ? null : itemId(input.threadId, input.turnId!, input.itemId),
      };
    },
    captureGap: (input) => ({
      ...input, threadId: threadId(input.threadId),
      turnId: input.turnId === null ? null : turnId(input.threadId, input.turnId),
    }),
    canonicalWindow: (input) => ({
      ...input, threadId: threadId(input.threadId), observations: input.observations.map(mapAtomic),
      materializedTurnIds: input.materializedTurnIds.map((id) => turnId(input.threadId, id)),
    }),
    providerTurnScope: (input) => ({
      ...input, threadId: threadId(input.threadId), observations: input.observations.map(mapAtomic),
      completeTurnIds: input.completeTurnIds.map((id) => turnId(input.threadId, id)),
    }),
    turnCatalog: (input) => ({
      ...input, threadId: threadId(input.threadId), catalog: input.catalog.map(mapCatalog),
    }),
    usageWindow: (input) => ({
      ...input, threadId: threadId(input.threadId), catalog: input.catalog.map(mapCatalog),
      observations: input.observations.map((entry) => mappings[entry.kind](entry as never)),
    }),
  };
  return mappings[observation.kind](observation as never);
}

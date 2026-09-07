/*
 * Keywords: provider, identity, item admission, native references, live projection.
 * Exports:
 * - WorkbenchProviderIdentityOwners: existing committed thread and item identity ports.
 * - WorkbenchNativeTurnIdentity: private provider destination for one observed turn.
 * - admitProviderThreadItems: batch structural identity before publishing provider items.
 * - mapProviderThreadItem: project admitted identity and explicit references without database work.
 * - mapProviderTurn: project a supplied turn through the same committed item lookup.
 * - mapProviderThread: project supplied thread metadata and turns without provider rereads.
 * - mapProviderNotification: map typed notification references without rewriting provider payloads.
 * - admitProviderThreads: batch supplied metadata, ordered catalogs and loaded item identities.
 * - admitProviderNotifications: admit a provider event's structural facts before ordered publication.
 * - WorkbenchProviderIdentityAdmissionOwners: durable admission ports at the provider boundary.
 */
import type { ServerNotification } from "workbench-shared/codex/generated/app-server/ServerNotification";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import { readWorkbenchTurnHistory } from "workbench-shared/codex/thread-adapter";
import { getCodexItemIdentityKind, withCodexItemMetadata } from "workbench-shared/codex/thread-item-source";
import { withWorkbenchThreadItemIdentity } from "workbench-shared/workbench/thread/thread-item-identity";
import { getWorkbenchTurnAdmission } from "workbench-shared/workbench/thread/thread-admission";
import type { WorkbenchNativeThreadIdentity, WorkbenchThreadIdentityMetadata } from "./database/thread-identity/workbench-thread-identity-types";
import type { WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import type { WorkbenchTranscriptItemSource } from "./database/transcript/workbench-transcript-types";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchTranscriptIdentityController from "./WorkbenchTranscriptIdentityController";

export interface WorkbenchProviderIdentityOwners {
  threads: Pick<WorkbenchThreadIdentityController, "workbenchIdForNative" | "workbenchTurnIdForNative" | "knownNativeBinding">;
  items: Pick<WorkbenchTranscriptIdentityController, "admit" | "itemIdForSource" | "itemIdForReference">;
}

export interface WorkbenchNativeTurnIdentity extends WorkbenchNativeThreadIdentity {
  nativeTurnId: string;
}

export interface WorkbenchProviderIdentityAdmissionOwners extends WorkbenchProviderIdentityOwners {
  threads: WorkbenchProviderIdentityOwners["threads"]
    & Pick<WorkbenchThreadIdentityController, "observeMany" | "observeTurns">;
}

export async function admitProviderNotifications(
  owners: WorkbenchProviderIdentityAdmissionOwners,
  native: WorkbenchNativeThreadIdentity,
  notifications: readonly ServerNotification[],
) {
  const turns = notifications.flatMap((event) => (
    (event.method === "turn/started" || event.method === "turn/completed")
      && getWorkbenchTurnAdmission(event.params.turn) === "admitted" ? [event.params.turn] : []
  ));
  if (turns.length) {
    const threadId = owners.threads.workbenchIdForNative(native);
    await owners.threads.observeTurns(turns.map((turn) => ({
      kind: "turn", threadId, turnId: turn.id, nativeTurnId: turn.id,
      harnessId: native.harness, nativeLocation: native.nativeLocation, nativeThreadId: native.nativeThreadId,
      state: turn.status, createdAt: Math.round(turn.startedAt * 1_000),
      startedAt: Math.round(turn.startedAt * 1_000),
      endedAt: turn.completedAt === null ? null : Math.round(turn.completedAt * 1_000),
      durationMs: turn.durationMs,
    })));
  }
  const items = notifications.flatMap((event) => {
    if (event.method === "item/started" || event.method === "item/completed") {
      return [{ turnId: event.params.turnId, item: event.params.item }];
    }
    if ((event.method === "turn/started" || event.method === "turn/completed")
      && getWorkbenchTurnAdmission(event.params.turn) === "admitted") {
      return event.params.turn.items.map((item) => ({ turnId: event.params.turn.id, item }));
    }
    return [];
  });
  if (items.length) {
    const threadId = owners.threads.workbenchIdForNative(native);
    await owners.items.admit(items.map(({ turnId: nativeTurnId, item }) => {
      const turnId = owners.threads.workbenchTurnIdForNative({ ...native, nativeTurnId });
      return {
        threadId,
        sources: [
          providerItemSource({ ...native, nativeTurnId }, turnId, item),
          ...(item.type === "userMessage" && item.clientId ? [{ turnId, kind: "client" as const, sourceId: item.clientId }] : []),
        ],
        legacyAliases: [],
      };
    }));
  }
}

export async function admitProviderThreads(
  owners: WorkbenchProviderIdentityAdmissionOwners,
  inputs: readonly { metadata: WorkbenchThreadIdentityMetadata; thread: Thread }[],
) {
  const identities = await owners.threads.observeMany(inputs.map(({ metadata }) => metadata));
  const catalogs = inputs.map(({ metadata, thread }, index) => {
    const loaded = new Map(thread.turns.map((turn) => [turn.id, turn]));
    const catalog = (readWorkbenchTurnHistory(thread) ?? thread.turns.map((turn): WorkbenchThreadTurnHistoryEntry => ({
      turnId: turn.id, status: turn.status, startedAt: turn.startedAt,
      completedAt: turn.completedAt, durationMs: turn.durationMs,
      itemCount: turn.items.length, loadState: "loaded",
    }))).filter((entry) => {
      const turn = loaded.get(entry.turnId);
      return !turn || getWorkbenchTurnAdmission(turn) === "admitted";
    });
    return { metadata, thread, identity: identities[index]!, loaded, catalog };
  });
  await owners.threads.observeTurns(catalogs.flatMap(({ metadata, thread, identity, catalog }) => catalog.map((entry) => ({
    kind: "turn", threadId: identity.threadId, turnId: entry.turnId,
    harnessId: metadata.native.harness, nativeLocation: metadata.native.nativeLocation,
    nativeThreadId: metadata.native.nativeThreadId, nativeTurnId: entry.turnId,
    state: entry.status ?? "admitted",
    createdAt: Math.round((entry.startedAt ?? thread.createdAt) * 1_000),
    startedAt: entry.startedAt === null ? null : Math.round(entry.startedAt * 1_000),
    endedAt: entry.completedAt === null ? null : Math.round(entry.completedAt * 1_000),
    durationMs: entry.durationMs,
  }))));
  const admissions = catalogs.flatMap(({ metadata, identity, catalog, loaded }) => catalog.flatMap((entry) => {
    const turnId = owners.threads.workbenchTurnIdForNative({ ...metadata.native, nativeTurnId: entry.turnId });
    const items = new Map((loaded.get(entry.turnId)?.items ?? []).map((item) => [item.id, item]));
    const timelines = new Map((entry.itemTimeline ?? []).map((timeline) => [timeline.itemId, timeline]));
    const references = new Set([...items.keys(), ...entry.itemIds ?? [], ...timelines.keys()]);
    return [...references].map((sourceId) => {
      const item = items.get(sourceId);
      return {
        threadId: identity.threadId,
        sources: [
          { turnId, sourceId, kind: metadata.native.harness === "codex"
            ? getCodexItemIdentityKind(item ?? { id: sourceId }) : "stable" as const },
          ...(item?.type === "userMessage" && item.clientId
            ? [{ turnId, kind: "client" as const, sourceId: item.clientId }] : []),
        ],
        legacyAliases: (timelines.get(sourceId)?.aliases ?? []).map((alias) => ({ turnId, alias })),
      };
    });
  }));
  if (admissions.length) await owners.items.admit(admissions);
  return identities;
}

export function mapProviderTurn(
  owners: WorkbenchProviderIdentityOwners,
  native: WorkbenchNativeThreadIdentity,
  turn: Turn,
): Turn {
  if (getWorkbenchTurnAdmission(turn) !== "admitted") return turn;
  const nativeTurn = { ...native, nativeTurnId: turn.id };
  return {
    ...turn,
    id: owners.threads.workbenchTurnIdForNative(nativeTurn),
    items: turn.items.map((item) => mapProviderThreadItem(owners, nativeTurn, item)),
  };
}

export function mapProviderThread(
  owners: WorkbenchProviderIdentityOwners,
  native: Pick<WorkbenchNativeThreadIdentity, "harness" | "nativeLocation">,
  thread: Thread,
): Thread {
  const identity = { ...native, nativeThreadId: thread.id };
  const threadId = owners.threads.workbenchIdForNative(identity);
  const pending = new Set(thread.turns.filter((turn) => getWorkbenchTurnAdmission(turn) !== "admitted").map((turn) => turn.id));
  const history = readWorkbenchTurnHistory(thread)?.filter((entry) => !pending.has(entry.turnId)).map((entry) => {
    const turnId = owners.threads.workbenchTurnIdForNative({ ...identity, nativeTurnId: entry.turnId });
    const itemId = (reference: string) => owners.items.itemIdForReference(threadId, turnId, reference);
    return {
      ...entry, turnId,
      ...(entry.itemIds ? { itemIds: entry.itemIds.map(itemId) } : {}),
      ...(entry.itemTimeline ? { itemTimeline: entry.itemTimeline.map((timeline) => ({
        ...timeline, itemId: itemId(timeline.itemId),
        ...(timeline.aliases ? { aliases: [...new Set(timeline.aliases.map(itemId))] } : {}),
      })) } : {}),
    };
  });
  let source = thread.source;
  if (typeof source === "object" && "subAgent" in source
    && typeof source.subAgent === "object" && "thread_spawn" in source.subAgent) {
    source = { subAgent: { thread_spawn: {
      ...source.subAgent.thread_spawn,
      parent_thread_id: owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, source.subAgent.thread_spawn.parent_thread_id)),
    } } };
  }
  return {
    ...thread,
    id: threadId,
    forkedFromId: null,
    parentThreadId: thread.parentThreadId === null ? null : owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, thread.parentThreadId)),
    source,
    turns: thread.turns.map((turn) => mapProviderTurn(owners, identity, turn)),
    ...(history ? { workbenchTurnHistory: history } : {}),
  };
}

export function mapProviderNotification(
  owners: WorkbenchProviderIdentityOwners,
  native: Pick<WorkbenchNativeThreadIdentity, "harness" | "nativeLocation">,
  notification: ServerNotification,
): ServerNotification {
  if (notification.method === "thread/started") {
    return { ...notification, params: { ...notification.params, thread: mapProviderThread(owners, native, notification.params.thread) } };
  }
  const params = notification.params;
  if (!("threadId" in params) || params.threadId === null) return notification;
  const identity = { ...native, nativeThreadId: params.threadId };
  const threadId = owners.threads.workbenchIdForNative(identity);
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    return { ...notification, params: { ...notification.params, threadId,
      turn: mapProviderTurn(owners, identity, notification.params.turn) } };
  }
  if (notification.method === "item/started" || notification.method === "item/completed") {
    const nativeTurn = { ...identity, nativeTurnId: notification.params.turnId };
    const references = { threadId,
      turnId: owners.threads.workbenchTurnIdForNative(nativeTurn),
      item: mapProviderThreadItem(owners, nativeTurn, notification.params.item) };
    return notification.method === "item/started"
      ? { ...notification, params: { ...notification.params, ...references } }
      : { ...notification, params: { ...notification.params, ...references } };
  }
  const turnId = "turnId" in params && params.turnId !== null
    ? owners.threads.workbenchTurnIdForNative({ ...identity, nativeTurnId: params.turnId })
    : null;
  const itemId = turnId !== null && "itemId" in params && typeof params.itemId === "string"
    ? owners.items.itemIdForReference(threadId, turnId, params.itemId)
    : null;
  // Only declared top-level thread/turn/item references change. Nested payloads and correlation IDs remain native.
  return { ...notification, params: { ...params, threadId,
    ...(turnId === null ? {} : { turnId }), ...(itemId === null ? {} : { itemId }) } } as ServerNotification;
}

export async function admitProviderThreadItems(
  owners: WorkbenchProviderIdentityOwners,
  native: WorkbenchNativeTurnIdentity,
  items: readonly ThreadItem[],
): Promise<ThreadItem[]> {
  if (!items.length) return [];
  const threadId = owners.threads.workbenchIdForNative(native);
  const turnId = owners.threads.workbenchTurnIdForNative(native);
  await owners.items.admit(items.map((item) => ({
    threadId,
    sources: [
      providerItemSource(native, turnId, item),
      ...(item.type === "userMessage" && item.clientId
        ? [{ turnId, kind: "client" as const, sourceId: item.clientId }]
        : []),
    ],
    legacyAliases: [],
  })));
  return items.map((item) => mapProviderThreadItem(owners, native, item));
}

export function mapProviderThreadItem(
  owners: WorkbenchProviderIdentityOwners,
  native: WorkbenchNativeTurnIdentity,
  item: ThreadItem,
): ThreadItem {
  const threadId = owners.threads.workbenchIdForNative(native);
  const turnId = owners.threads.workbenchTurnIdForNative(native);
  const source = providerItemSource(native, turnId, item);
  const id = owners.items.itemIdForSource(threadId, source);
  const admitted = native.harness === "codex" ? withCodexItemMetadata(item) : item;
  const mapped = withWorkbenchThreadItemIdentity({ ...admitted, id }, source.kind === "provisional" ? "provisional" : "stable");
  if (mapped.type === "subAgentActivity") {
    return {
      ...mapped,
      agentThreadId: owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, mapped.agentThreadId)),
    };
  }
  if (mapped.type === "collabAgentToolCall") {
    const agentsStates: typeof mapped.agentsStates = {};
    for (const [nativeThreadId, state] of Object.entries(mapped.agentsStates)) {
      const canonicalThreadId = owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, nativeThreadId));
      if (Object.hasOwn(agentsStates, canonicalThreadId)) {
        throw new Error("Provider agent states have multiple entries for one Workbench thread.");
      }
      agentsStates[canonicalThreadId] = state;
    }
    return {
      ...mapped,
      senderThreadId: owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, mapped.senderThreadId)),
      receiverThreadIds: mapped.receiverThreadIds.map((nativeThreadId) => (
        owners.threads.workbenchIdForNative(owners.threads.knownNativeBinding(native.harness, nativeThreadId))
      )),
      agentsStates,
    };
  }
  return mapped;
}

function providerItemSource(
  native: WorkbenchNativeTurnIdentity,
  turnId: string,
  item: ThreadItem,
): WorkbenchTranscriptItemSource {
  return {
    turnId,
    kind: native.harness === "codex" ? getCodexItemIdentityKind(item) : "stable",
    sourceId: item.id,
  };
}

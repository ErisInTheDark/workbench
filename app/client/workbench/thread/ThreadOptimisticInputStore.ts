/*
 * Exports:
 * - OptimisticInputEntry: one stable optimistic user-input lifecycle record.
 * - OptimisticInputStatus/OptimisticInputPlacement: optimistic rendering state.
 * - ThreadOptimisticInputStoreOptions: injectable native client-ID factory and enqueue clock.
 * - EnqueueInitialOptimisticInputOptions: native identity and status for one initial message.
 * - OptimisticInitialInputProjection: read-only initial input evidence for source-specific presentation.
 * - isPendingInitialOptimisticInputItem: derive pre-admission connecting state from optimistic item truth.
 * - isUndeliveredInitialOptimisticInputItem: detect visible initial input awaiting canonical transcript delivery.
 * - ThreadOptimisticInputStore: owner for optimistic input identity, status, placement, and canonical correlation.
 * - default ThreadOptimisticInputStore: create the optimistic input owner.
 */

import type { ThreadItem, UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { areUserInputsEquivalentForUserMessageDedupe } from "workbench-shared/workbench/thread/thread-item-normalization";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import { createThreadDocumentKeyForThread } from "./thread-document-keys";
import { isSyntheticSteerHistoryItem } from "workbench-shared/workbench/thread/thread-steer-history";
import { projectWorkbenchThreadItemTimelines } from "workbench-shared/workbench/thread/thread-item-timeline";
import { getWorkbenchInputState, withWorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";

type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;

export type OptimisticInputPlacement = "initial" | "steer";
export type OptimisticInputStatus = "pending" | "sent" | "failed" | "interrupted";

export interface OptimisticInputEntry {
  enqueuedAt: number;
  clientUserMessageId: string | null;
  canonicalItemId: string | null;
  canonicalMatchBaseline: number;
  duplicateOrdinal: number;
  handle: string;
  input: UserInput[];
  item: UserMessageItem;
  placement: OptimisticInputPlacement;
  status: OptimisticInputStatus;
  threadKey: string;
  turnId: string;
}

export interface ThreadOptimisticInputStoreOptions {
  createClientUserMessageId?: () => string;
  now?: () => number;
}

export interface EnqueueInitialOptimisticInputOptions {
  clientUserMessageId?: string | null;
  status?: OptimisticInputStatus;
}

export interface OptimisticInitialInputProjection {
  readonly item: UserMessageItem;
  readonly turnId: string;
}

export interface ThreadOptimisticInputStore {
  apply: (thread: ThreadPayload, steerHistory: readonly WorkbenchSteerHistoryEntry[]) => ThreadPayload;
  clear: () => void;
  confirmCanonicalUserMessage: (threadKey: string, turnId: string, item: UserMessageItem) => string | null;
  createClientUserMessageId: () => string;
  deleteThread: (threadKey: string) => void;
  discard: (handle: string) => boolean;
  enqueueInitial: (thread: ThreadPayload, turnId: string, input: UserInput[], options?: EnqueueInitialOptimisticInputOptions) => OptimisticInputEntry;
  enqueueSteer: (thread: ThreadPayload, turnId: string, input: UserInput[], status?: OptimisticInputStatus) => OptimisticInputEntry;
  getInitialProjections: (threadKey: string) => readonly OptimisticInitialInputProjection[];
  movePending: (handle: string, turnId: string, placement?: OptimisticInputPlacement) => boolean;
  strip: (thread: ThreadPayload) => ThreadPayload;
  transition: (handle: string, status: Exclude<OptimisticInputStatus, "pending">) => OptimisticInputStatus | null;
  transitionPendingSteers: (threadKey: string, turnId: string, status: "failed" | "interrupted") => boolean;
}

function cloneUserInput(input: UserInput): UserInput {
  switch (input.type) {
    case "text":
      return { text: input.text, text_elements: input.text_elements.map((element) => ({ byteRange: { ...element.byteRange }, placeholder: element.placeholder })), type: input.type };
    case "image":
      return { type: input.type, url: input.url };
    case "localImage":
      return { path: input.path, type: input.type };
    case "skill":
      return { name: input.name, path: input.path, type: input.type };
    case "mention":
      return { name: input.name, path: input.path, type: input.type };
  }
  throw new Error("Unsupported optimistic user input.");
}

function isOptimisticItem(item: ThreadItem) {
  return getWorkbenchInputState(item)?.kind === "optimistic";
}

export function isPendingInitialOptimisticInputItem(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return input?.kind === "optimistic" && input.placement === "initial" && input.status === "pending";
}

export function isUndeliveredInitialOptimisticInputItem(item: ThreadItem) {
  const input = getWorkbenchInputState(item);
  return input?.kind === "optimistic"
    && input.placement === "initial"
    && (input.status === "pending" || input.status === "sent");
}

function createOptimisticItem(entry: Pick<OptimisticInputEntry, "handle" | "input" | "placement" | "status" | "clientUserMessageId">): UserMessageItem {
  return withWorkbenchInputState({
    clientId: entry.clientUserMessageId,
    content: entry.input.map(cloneUserInput),
    id: entry.handle,
    type: "userMessage",
  }, { kind: "optimistic", placement: entry.placement, status: entry.status });
}

function getTurn(thread: ThreadPayload, turnId: string) {
  return thread.turns.find((turn) => turn.id === turnId) ?? null;
}

function countCanonicalMatches(thread: ThreadPayload, turnId: string, input: UserInput[]) {
  return getTurn(thread, turnId)?.items.filter((item) => (
    item.type === "userMessage"
    && !isOptimisticItem(item)
    && !isSyntheticSteerHistoryItem(item)
    && areUserInputsEquivalentForUserMessageDedupe(item.content, input)
  )).length ?? 0;
}

function insertInitialItems(items: ThreadItem[], optimisticItems: UserMessageItem[]) {
  if (!optimisticItems.length) {
    return items;
  }
  let insertIndex = 0;
  while (items[insertIndex]?.type === "userMessage") {
    insertIndex += 1;
  }
  return [...items.slice(0, insertIndex), ...optimisticItems, ...items.slice(insertIndex)];
}

function placeCanonicalInitialUserMessages(items: ThreadItem[], entries: OptimisticInputEntry[]) {
  const initialEntries = entries.filter((entry) => entry.placement === "initial");
  if (!initialEntries.length) {
    return items;
  }

  let nextItems = items;
  let changed = false;
  for (const entry of initialEntries) {
    const currentIndex = nextItems.findIndex((item) => (
      item.type === "userMessage"
      && !isOptimisticItem(item)
      && !isSyntheticSteerHistoryItem(item)
      && (entry.item.clientId
        ? item.clientId === entry.item.clientId
        : areUserInputsEquivalentForUserMessageDedupe(item.content, entry.input))
    ));
    if (currentIndex < 0) {
      continue;
    }

    let insertIndex = 0;
    while (nextItems[insertIndex]?.type === "userMessage") {
      insertIndex += 1;
    }
    if (currentIndex < insertIndex) {
      continue;
    }

    const canonicalItem = nextItems[currentIndex]!;
    const withoutItem = [...nextItems.slice(0, currentIndex), ...nextItems.slice(currentIndex + 1)];
    insertIndex = 0;
    while (withoutItem[insertIndex]?.type === "userMessage") {
      insertIndex += 1;
    }
    nextItems = [...withoutItem.slice(0, insertIndex), canonicalItem, ...withoutItem.slice(insertIndex)];
    changed = true;
  }
  return changed ? nextItems : items;
}

function ThreadOptimisticInputStore({ createClientUserMessageId = () => crypto.randomUUID(), now = Date.now }: ThreadOptimisticInputStoreOptions = {}): ThreadOptimisticInputStore {
  const entries: OptimisticInputEntry[] = [];

  function replaceEntry(index: number, entry: OptimisticInputEntry) {
    const nextEntry = { ...entry, item: createOptimisticItem(entry) };
    entries[index] = nextEntry;
    return nextEntry;
  }

  function enqueue(
    thread: ThreadPayload,
    turnId: string,
    input: UserInput[],
    placement: OptimisticInputPlacement,
    status: OptimisticInputStatus,
    clientUserMessageId?: string | null,
  ) {
    const threadKey = createThreadDocumentKeyForThread(thread);
    const clonedInput = input.map(cloneUserInput);
    const canonicalMatchBaseline = countCanonicalMatches(thread, turnId, clonedInput);
    const duplicateOrdinal = entries.filter((entry) => (
      entry.threadKey === threadKey
      && entry.turnId === turnId
      && entry.canonicalMatchBaseline === canonicalMatchBaseline
      && entry.status !== "failed"
      && entry.status !== "interrupted"
      && areUserInputsEquivalentForUserMessageDedupe(entry.input, clonedInput)
    )).length;
    const clientMessageId = clientUserMessageId?.trim().toLowerCase()
      || (placement === "steer" ? createClientUserMessageId().toLowerCase() : null);
    const handle = clientMessageId ?? crypto.randomUUID();
    const entry: OptimisticInputEntry = {
      enqueuedAt: now(),
      clientUserMessageId: clientMessageId,
      canonicalItemId: null,
      canonicalMatchBaseline,
      duplicateOrdinal,
      handle,
      input: clonedInput,
      item: { clientId: null, content: [], id: "", type: "userMessage" },
      placement,
      status,
      threadKey,
      turnId,
    };
    entry.item = createOptimisticItem(entry);
    entries.push(entry);
    return entry;
  }

  return {
    apply(thread, steerHistory) {
      const stripped = this.strip(thread);
      const threadKey = createThreadDocumentKeyForThread(stripped);
      const matchingEntries = entries.filter((entry) => entry.threadKey === threadKey);
      if (!matchingEntries.length) {
        return stripped;
      }
      const exactHistoryByClientId = new Map(
        steerHistory.flatMap((history) => history.clientUserMessageId
          ? [[history.clientUserMessageId, history] as const]
          : []),
      );

      let changed = stripped !== thread;
      const turns = stripped.turns.map((turn) => {
        const turnEntries = matchingEntries.filter((entry) => entry.turnId === turn.id);
        if (!turnEntries.length) {
          return turn;
        }

        const canonicalItems = placeCanonicalInitialUserMessages(turn.items, turnEntries);
        if (canonicalItems !== turn.items) {
          changed = true;
        }

        const visibleEntries = turnEntries.filter((entry) => {
          const exactHistory = exactHistoryByClientId.get(entry.handle);
          if (exactHistory?.status === "pending" || exactHistory?.status === "failed" || exactHistory?.status === "interrupted") {
            return false;
          }
          if (exactHistory?.status === "sent") {
            const hasCanonicalItem = canonicalItems.some((item) => (
              item.type === "userMessage"
              && !isSyntheticSteerHistoryItem(item)
              && (item.id === exactHistory.canonicalItemId || item.clientId === entry.handle)
            ));
            if (hasCanonicalItem) {
              return false;
            }
          }

          if (entry.status === "failed" || entry.status === "interrupted") {
            return true;
          }

          if (entry.item.clientId) {
            return !canonicalItems.some((item) => item.type === "userMessage" && !isSyntheticSteerHistoryItem(item) && item.clientId === entry.handle);
          }

          const canonicalMatches = countCanonicalMatches(stripped, turn.id, entry.input);
          return canonicalMatches < entry.canonicalMatchBaseline + entry.duplicateOrdinal + 1;
        });
        if (!visibleEntries.length) {
          return canonicalItems === turn.items ? turn : { ...turn, items: canonicalItems };
        }

        changed = true;
        const projectEntryItem = (entry: OptimisticInputEntry) => (
          exactHistoryByClientId.get(entry.handle)?.status === "sent" && entry.status !== "sent"
            ? createOptimisticItem({ ...entry, status: "sent" })
            : entry.item
        );
        const initialItems = visibleEntries.filter((entry) => entry.placement === "initial").map(projectEntryItem);
        const steerItems = visibleEntries.filter((entry) => entry.placement === "steer").map(projectEntryItem);
        return { ...turn, items: [...insertInitialItems(canonicalItems, initialItems), ...steerItems] };
      });
      return projectWorkbenchThreadItemTimelines(changed ? { ...stripped, turns } : thread, (turn) => (
        matchingEntries.filter((entry) => entry.turnId === turn.id).flatMap((entry) => {
          const item = turn.items.find((candidate) => isOptimisticItem(candidate) && (
            candidate.id === entry.item.id
            || (candidate.type === "userMessage" && candidate.clientId !== null && candidate.clientId === entry.item.clientId)
          ));
          return item ? [{
            completedAt: null,
            firstSeenAt: entry.enqueuedAt,
            itemId: item.id,
            lastSeenAt: null,
            startedAt: null,
          }] : [];
        })
      ));
    },
    clear() {
      entries.splice(0, entries.length);
    },
    createClientUserMessageId() {
      return createClientUserMessageId().toLowerCase();
    },
    confirmCanonicalUserMessage(threadKey, turnId, item) {
      if (!item.clientId) {
        return null;
      }
      const index = entries.findIndex((entry) => entry.threadKey === threadKey && entry.handle === item.clientId);
      if (index < 0) {
        return null;
      }
      const entry = entries[index]!;
      if (entry.status === "sent" && entry.turnId === turnId && entry.canonicalItemId === item.id) {
        return entry.handle;
      }
      replaceEntry(index, { ...entry, canonicalItemId: item.id, status: "sent", turnId });
      return entry.handle;
    },
    deleteThread(threadKey) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.threadKey === threadKey) {
          entries.splice(index, 1);
        }
      }
    },
    discard(handle) {
      const index = entries.findIndex((entry) => entry.handle === handle);
      if (index < 0) {
        return false;
      }
      entries.splice(index, 1);
      return true;
    },
    enqueueInitial(thread, turnId, input, options = {}) {
      return enqueue(thread, turnId, input, "initial", options.status ?? "pending", options.clientUserMessageId);
    },
    enqueueSteer(thread, turnId, input, status = "pending") {
      return enqueue(thread, turnId, input, "steer", status);
    },
    getInitialProjections(threadKey) {
      return entries.flatMap(entry => (
        entry.threadKey === threadKey
        && entry.placement === "initial"
        && (entry.status === "pending" || entry.status === "sent")
          ? [{ item: entry.item, turnId: entry.turnId }]
          : []
      ));
    },
    movePending(handle, turnId, placement) {
      const index = entries.findIndex((entry) => entry.handle === handle);
      if (index < 0 || entries[index]?.status !== "pending") {
        return false;
      }
      if (entries[index]?.turnId === turnId && (!placement || entries[index]?.placement === placement)) {
        return true;
      }
      replaceEntry(index, { ...entries[index]!, placement: placement ?? entries[index]!.placement, turnId });
      return true;
    },
    strip(thread) {
      let changed = false;
      const turns = thread.turns.map((turn) => {
        const items = turn.items.filter((item) => !isOptimisticItem(item));
        if (items.length === turn.items.length) {
          return turn;
        }
        changed = true;
        return { ...turn, items };
      });
      return changed ? { ...thread, turns } : thread;
    },
    transition(handle, status) {
      const index = entries.findIndex((entry) => entry.handle === handle);
      if (index < 0) {
        return null;
      }
      const entry = entries[index]!;
      if (
        (entry.status === "sent" && status !== "sent")
        || (entry.status === "interrupted" && status === "failed")
      ) {
        return entry.status;
      }
      if (entry.status !== status) {
        replaceEntry(index, { ...entry, status });
      }
      return entries[index]!.status;
    },
    transitionPendingSteers(threadKey, turnId, status) {
      let changed = false;
      entries.forEach((entry, index) => {
        if (entry.threadKey === threadKey && entry.turnId === turnId && entry.placement === "steer" && entry.status === "pending") {
          replaceEntry(index, { ...entry, status });
          changed = true;
        }
      });
      return changed;
    },
  };
}

export default ThreadOptimisticInputStore;

/*
 * Exports:
 * - TranscriptBodiesContext: the nearest rendered transcript's deferred item body owner; absent where bodies arrive eagerly.
 * - TranscriptScope/TranscriptScopeContext: the thread a rendered transcript shows, with its related threads and subagents.
 * - TranscriptTurnScope/TranscriptTurnContext: the turn a transcript renderer is inside.
 * - useTranscript: the nearest rendered transcript's scope. Members: `turn` its current turn;
 *   `turns/approvals` read a leased store's transcript slices; `presentedText` subscribes to one exact streaming text field;
 *   `item` hydrates one deferred item's body (tool output, full reasoning).
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkbenchBrowseResultEntry, WorkbenchSubagentSummary } from "workbench-shared/types";
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type ThreadStore from "../../workbench/thread/ThreadStore";
import {
  EMPTY_THREAD_STORE_STATE, type RelatedThread, type ThreadSliceName, type ThreadStoreState,
} from "../../workbench/thread/ThreadStore";
import type ThreadTranscriptBodies from "../../workbench/transcript/ThreadTranscriptBodies";
import type { ThreadTranscriptBodyState } from "../../workbench/transcript/ThreadTranscriptBodies";
import type {
  ThreadTextPresentationField, ThreadTextPresentationKey, ThreadTextPresentationSource,
} from "../../workbench/thread/ThreadTextPresentationController";
import ThreadTextPresentationContext from "./ThreadTextPresentationContext";
import WorkbenchClientContext from "./workbench-client-context";

export const TranscriptBodiesContext = createContext<ThreadTranscriptBodies | null>(null);

/** The thread a transcript shows; its project facts belong to the contextual project (`useProject.contextual()`). */
export interface TranscriptScope {
  relatedThreadsById: Readonly<Record<string, RelatedThread | undefined>>;
  subagents: readonly WorkbenchSubagentSummary[];
  threadId: string;
}

export interface TranscriptTurnScope {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  completedAt: number | null;
  id: string;
  /** Live text presentation for the turn the thread is working on; settled turns show canonical text. */
  presentationSource: ThreadTextPresentationSource | null;
  startedAt: number | null;
  status: Turn["status"];
}

export const TranscriptScopeContext = createContext<TranscriptScope | null>(null);
export const TranscriptTurnContext = createContext<TranscriptTurnScope | null>(null);

const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};
const READY: ThreadTranscriptBodyState = { status: "idle" };

function useSlice<Name extends ThreadSliceName>(store: ThreadStore | null, name: Name): ThreadStoreState[Name] {
  const subscribe = useCallback((listener: () => void) => store?.subscribe(name, listener) ?? (() => {}), [store, name]);
  const read = useCallback(() => store?.getSlice(name) ?? EMPTY_THREAD_STORE_STATE[name], [store, name]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useTranscript(): TranscriptScope {
  const scope = useContext(TranscriptScopeContext);
  if (!scope) throw new Error("useTranscript needs a rendered transcript (TranscriptScopeContext).");
  return scope;
}

useTranscript.turn = function useTranscriptTurn(): TranscriptTurnScope {
  const turn = useContext(TranscriptTurnContext);
  if (!turn) throw new Error("useTranscript.turn needs a transcript turn (TranscriptTurnContext).");
  return turn;
};

useTranscript.turns = function useTranscriptTurns(store: ThreadStore | null) { return useSlice(store, "turns"); };
useTranscript.approvals = function useTranscriptApprovals(store: ThreadStore | null) { return useSlice(store, "approvals"); };

/** One exact streaming text field of an optional presentation source, falling back to its canonical text. */
useTranscript.presentedText = function useTranscriptPresentedText({
  canonicalText, field, index = null, itemId, source, threadId, turnId,
}: {
  canonicalText: string;
  field: ThreadTextPresentationField;
  index?: number | null;
  itemId: string;
  source?: ThreadTextPresentationSource | null;
  threadId: string;
  turnId: string;
}) {
  const mounted = useContext(WorkbenchClientContext)?.mounted;
  const standaloneText = useContext(ThreadTextPresentationContext);
  const controller = source
    ? mounted?.threadTextPresentationFor(threadId) ?? standaloneText
    : mounted?.threadTextPresentation ?? standaloneText;
  const sourceKind = source?.kind;
  const sourceKey = source?.sourceKey;
  const key = useMemo<ThreadTextPresentationKey | null>(() => sourceKind && sourceKey !== undefined ? {
    field, index, itemId, source: { kind: sourceKind, sourceKey }, threadId, turnId,
  } : null, [field, index, itemId, sourceKind, sourceKey, threadId, turnId]);
  const getSnapshot = useCallback(
    () => key ? controller?.getSnapshot(key) ?? canonicalText : canonicalText,
    [canonicalText, controller, key],
  );
  // Streamed text grows the item in place, so re-renders see longer text; resubscribing on it would drop the field's
  // reveal and snap to the whole text. The subscription follows the field identity and reads the latest text.
  const canonicalTextRef = useRef(canonicalText);
  useLayoutEffect(() => { canonicalTextRef.current = canonicalText; });
  const subscribe = useCallback((listener: () => void) => (
    key && controller ? controller.subscribe(key, canonicalTextRef.current, listener) : EMPTY_SUBSCRIBE(listener)
  ), [controller, key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => canonicalText);
};

/**
 * One item with its whole body: deferred bodies load from the nearest transcript when this hook mounts, so call it
 * where the output renders (inside an opened disclosure). Items delivered whole come back unchanged.
 */
useTranscript.item = function useTranscriptItem<Item extends ThreadItem>(item: Item) {
  const bodies = useContext(TranscriptBodiesContext);
  const deferred = "bodyDeferred" in item && item.bodyDeferred === true;
  const owner = deferred ? bodies : null;
  const itemId = item.id;
  const subscribe = useCallback((listener: () => void) => owner?.subscribe(itemId, listener) ?? (() => {}), [owner, itemId]);
  const read = useCallback(() => owner?.get(itemId) ?? READY, [owner, itemId]);
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { owner?.load(itemId); }, [owner, itemId]);
  const retry = useCallback(() => owner?.retry(itemId), [owner, itemId]);
  const hydrated = state.status === "loaded" && state.item.type === item.type ? state.item as unknown as Item : null;
  return {
    item: hydrated ?? item,
    status: !deferred ? "ready" as const
      : hydrated ? "ready" as const
        : !owner ? "unavailable" as const
          : state.status === "failed" ? "failed" as const : "loading" as const,
    failure: state.status === "failed" ? state.message : null,
    retry,
  };
};

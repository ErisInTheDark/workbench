/*
 * Exports:
 * - default useThreadHistoryPaging: page a thread view's older turns in as the reader nears the top, one page in flight,
 *   with a retryable failed state per paging boundary. Reconciles after every commit of the calling view.
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";

import previousTurnLoadReducer from "./previous-turn-load-state";
import ThreadHistoryPagingController, { type HistoryPagingOptions } from "./ThreadHistoryPagingController";

const HISTORY_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
const UPWARD_KEYS = ["ArrowUp", "PageUp", "Home"];

export default function useThreadHistoryPaging({
  thread, viewKey, canLoadOlder, renderedTurnIds, sourceReady, loadOlder, scrollViewportRef, reconcileLayout,
}: {
  thread: { id: string; harness: string } | null;
  /** The view instance; a new one starts paging afresh. */
  viewKey: string;
  canLoadOlder: boolean;
  renderedTurnIds: readonly string[];
  sourceReady: boolean;
  loadOlder: () => Promise<readonly string[] | null | undefined>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  /** Runs after every commit, before paging reconciles against the settled layout. */
  reconcileLayout: () => void;
}) {
  const [loadStates, dispatchLoad] = useReducer(previousTurnLoadReducer, {});
  // Older history can land inside the first loaded turn, so each completed page opens a new paging boundary.
  const [page, setPage] = useState(0);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const controllerRef = useRef<ThreadHistoryPagingController | null>(null);
  const bindingsRef = useRef<HistoryPagingOptions | null>(null);
  const previousTurnIdsRef = useRef<{ threadId: string; turnIds: readonly string[] } | null>(null);
  const generationRef = useRef(0);
  const threadId = thread?.id ?? "";
  const boundaryKey = thread && canLoadOlder ? `${thread.id}:${renderedTurnIds[0] ?? ""}:${page}` : "";
  const status = boundaryKey ? loadStates[boundaryKey] : undefined;
  const [identity, setIdentity] = useState(() => ({ key: `${viewKey}\0${threadId}` }));
  if (identity.key !== `${viewKey}\0${threadId}`) setIdentity({ key: `${viewKey}\0${threadId}` });

  const load = useCallback(async ({ retry = false }: { retry?: boolean } = {}) => {
    if (!thread || !boundaryKey || status === "loading" || (status === "failed" && !retry)) return;
    const generation = generationRef.current;
    const controller = controllerRef.current;
    const transaction = controller?.begin();
    if (!controller || transaction === null || transaction === undefined) return;
    dispatchLoad({ type: "start", key: boundaryKey });
    const fail = (reason: string) => {
      controller.fail(transaction);
      dispatchLoad({ type: "fail", key: boundaryKey });
      console.error(reason, { threadId: thread.id.slice(0, 160), harness: thread.harness.slice(0, 80) });
    };
    try {
      const turnIds = await loadOlder();
      if (generation !== generationRef.current) return;
      if (!turnIds) {
        fail("Previous thread turn load returned no turns while its view remained current.");
        return;
      }
      controller.succeed(transaction, turnIds);
      dispatchLoad({ type: "succeed", key: boundaryKey });
      setPage(current => current + 1);
    } catch (error) {
      if (generation !== generationRef.current) return;
      fail(`Previous thread turn load failed: ${(error instanceof Error ? error.message : "Unexpected history read failure")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500)}`);
    }
  }, [boundaryKey, loadOlder, status, thread]);

  useEffect(() => {
    generationRef.current += 1;
    dispatchLoad({ type: "reset" });
  }, [viewKey]);

  useLayoutEffect(() => {
    bindingsRef.current = {
      readView: () => {
        const viewport = scrollViewportRef.current;
        if (!viewport || !thread) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const sentinelRect = sentinel?.getBoundingClientRect();
        return {
          identity,
          viewport,
          boundaryKey: boundaryKey || null,
          requestStatus: status,
          sourceReady,
          renderedTurnIds,
          nearTop: Boolean(sentinelRect && viewport.clientHeight > 0
            && sentinelRect.bottom > viewportRect.top - viewport.clientHeight && sentinelRect.top < viewportRect.bottom),
        };
      },
      load: () => { void load(); },
      schedule: (callback, delayMs) => {
        const timer = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timer);
      },
    };
    controllerRef.current ??= new ThreadHistoryPagingController({
      readView: () => bindingsRef.current?.readView() ?? null,
      load: () => bindingsRef.current?.load(),
      schedule: bindingsRef.current.schedule,
    });
    reconcileLayout();
    controllerRef.current.reconcile();
  });

  // Turns dropping out of the loaded window means the view jumped; wait for the reader to ask for history again.
  useLayoutEffect(() => {
    const previous = previousTurnIdsRef.current;
    if (threadId && previous?.threadId === threadId) {
      const loaded = new Set(renderedTurnIds);
      if (previous.turnIds.some(turnId => !loaded.has(turnId))) controllerRef.current?.suppressUntilHistoryIntent();
    }
    previousTurnIdsRef.current = threadId ? { threadId, turnIds: renderedTurnIds } : null;
  }, [threadId, renderedTurnIds]);

  useLayoutEffect(() => () => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    bindingsRef.current = null;
  }, []);

  useEffect(() => {
    const scrollTarget = scrollViewportRef.current;
    if (!sentinel || !scrollTarget) return;
    const reconcile = () => controllerRef.current?.reconcile();
    const interrupt = (historyIntent = false) => controllerRef.current?.interrupt({ historyIntent });
    const handleWheel = (event: WheelEvent) => interrupt(event.deltaY < 0);
    const handleTouchMove = () => interrupt();
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (HISTORY_KEYS.includes(event.key)) interrupt(UPWARD_KEYS.includes(event.key) || (event.key === " " && event.shiftKey));
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target === scrollTarget) interrupt();
    };
    // One screen ahead, so history usually lands in the reserve before the reader reaches it.
    const observer = new IntersectionObserver(reconcile, { root: scrollTarget, rootMargin: "100% 0px 0px 0px", threshold: 0.1 });
    observer.observe(sentinel);
    scrollTarget.addEventListener("scroll", reconcile, { passive: true });
    scrollTarget.addEventListener("wheel", handleWheel, { passive: true });
    scrollTarget.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollTarget.addEventListener("keydown", handleKeyDown);
    scrollTarget.addEventListener("pointerdown", handlePointerDown);
    return () => {
      observer.disconnect();
      scrollTarget.removeEventListener("scroll", reconcile);
      scrollTarget.removeEventListener("wheel", handleWheel);
      scrollTarget.removeEventListener("touchmove", handleTouchMove);
      scrollTarget.removeEventListener("keydown", handleKeyDown);
      scrollTarget.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [sentinel, scrollViewportRef]);

  return { status, load, setSentinel };
}

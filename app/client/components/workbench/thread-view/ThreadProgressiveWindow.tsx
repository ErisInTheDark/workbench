/*
 * Exports:
 * - ThreadProgressiveWindowChunk: one stable exact-height transcript chunk.
 * - default ThreadProgressiveWindow: reveal older chunks in bounded prepends as the reader nears or passes them, restoring revealed extent across remounts.
 */
"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import ThreadProgressiveWindowController, {
  type ProgressiveWindowOptions,
} from "./ThreadProgressiveWindowController";

export interface ThreadProgressiveWindowChunk {
  key: string;
  content: ReactNode;
}

const INITIAL_CHUNK_COUNT = 1;

export default function ThreadProgressiveWindow({
  chunks,
  identity,
}: {
  chunks: readonly ThreadProgressiveWindowChunk[];
  identity: string;
}) {
  const viewport = useThreadScrollViewportContext();
  const identityToken = useMemo(() => ({}), [identity]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const initialStart = Math.max(0, chunks.length - INITIAL_CHUNK_COUNT);
  // The first visible chunk is held by key, so chunks landing above stay hidden instead of shifting what is shown.
  const [firstVisibleKey, setFirstVisibleKey] = useState<string | null>(() => (
    viewport.progressiveWindowing
      ? viewport.progressiveWindowStarts?.get(identity) ?? chunks[initialStart]?.key ?? null
      : null
  ));
  const visibleStartRef = useRef(0);
  const keyedStart = !viewport.progressiveWindowing ? 0
    : firstVisibleKey === null ? initialStart
    : chunks.findIndex(chunk => chunk.key === firstVisibleKey);
  const boundedStart = Math.min(keyedStart < 0 ? visibleStartRef.current : keyedStart, initialStart);
  visibleStartRef.current = boundedStart;
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  const firstVisibleChunkKey = chunks[boundedStart]?.key;
  // A windowed slice that unmounts and remounts must come back at its measured height, not one chunk.
  useEffect(() => {
    if (firstVisibleChunkKey !== undefined) viewport.progressiveWindowStarts?.set(identity, firstVisibleChunkKey);
  }, [firstVisibleChunkKey, identity, viewport.progressiveWindowStarts]);

  const readView = useCallback(() => {
    const scrollTarget = viewport.getViewport();
    const sentinel = sentinelRef.current;
    if (!scrollTarget || !sentinel) return null;
    return {
      hiddenCount: visibleStartRef.current,
      identity: identityToken,
      sentinelBottom: sentinel.getBoundingClientRect().bottom,
      viewport: scrollTarget,
      viewportHeight: scrollTarget.clientHeight,
      viewportTop: scrollTarget.getBoundingClientRect().top,
    };
  }, [identityToken, viewport]);
  const reveal = useCallback((count: number) => {
    const next = chunksRef.current[Math.max(0, visibleStartRef.current - count)];
    if (next) setFirstVisibleKey(next.key);
  }, []);
  const bindingsRef = useRef<ProgressiveWindowOptions>({ readView, reveal });
  bindingsRef.current = { readView, reveal };
  const controllerRef = useRef<ThreadProgressiveWindowController | null>(null);
  controllerRef.current ??= new ThreadProgressiveWindowController({
    readView: () => bindingsRef.current.readView(),
    reveal: count => bindingsRef.current.reveal(count),
  });

  // Window geometry only changes with its own reveal or chunk list; unrelated commits must not force layout here.
  // After paint, so the viewport has anchored the last reveal and each batch is its own frame: a layout-effect
  // reveal would chain every batch into one synchronous cascade.
  useEffect(() => {
    controllerRef.current?.reconcile();
  }, [boundedStart, chunks.length, identityToken]);
  // Reach is re-checked on every scroll and corrected layout change rather than on threshold crossings: a reveal's
  // anchor correction or a jump can move the sentinel into reach without any crossing being observed.
  const hasHidden = boundedStart > 0;
  useEffect(() => {
    if (!hasHidden) return;
    return viewport.onReaderMoved(() => controllerRef.current?.reconcile());
  }, [hasHidden, viewport]);
  const visibleChunks = chunks.slice(boundedStart);
  return (
    <div
      className="space-y-rendered-2"
      data-thread-progressive-window={identity}
      data-thread-progressive-hidden={boundedStart > 0 ? "true" : undefined}
    >
      <div ref={sentinelRef} className="h-px" aria-hidden />
      {visibleChunks.map(chunk => (
        <div key={chunk.key} data-thread-progressive-window-chunk={chunk.key}>
          {chunk.content}
        </div>
      ))}
    </div>
  );
}

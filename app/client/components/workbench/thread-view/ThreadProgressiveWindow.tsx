/*
 * Exports:
 * - ThreadProgressiveWindowChunk: one stable exact-height transcript chunk.
 * - default ThreadProgressiveWindow: reveal older chunks in bounded prepends while preserving the reading anchor.
 */
"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
const TOP_MARGIN_PX = 160;

export default function ThreadProgressiveWindow({
  chunks,
  identity,
}: {
  chunks: readonly ThreadProgressiveWindowChunk[];
  identity: string;
}) {
  const viewport = useThreadScrollViewportContext();
  const identityToken = useMemo(() => ({}), [identity]);
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visibleStart, setVisibleStart] = useState(() => (
    viewport.progressiveWindowing ? Math.max(0, chunks.length - INITIAL_CHUNK_COUNT) : 0
  ));
  const visibleStartRef = useRef(visibleStart);
  const boundedStart = Math.min(visibleStart, Math.max(0, chunks.length - INITIAL_CHUNK_COUNT));
  visibleStartRef.current = boundedStart;

  const readView = useCallback(() => {
    const root = rootRef.current;
    const scrollTarget = viewport.getViewport();
    const sentinel = sentinelRef.current;
    const anchor = root?.querySelector<HTMLElement>("[data-thread-progressive-window-chunk]");
    if (!root || !scrollTarget || !sentinel || !anchor) return null;
    const viewportRect = scrollTarget.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const anchorId = anchor.dataset.threadProgressiveWindowChunk;
    if (!anchorId) return null;
    return {
      anchor: {
        id: anchorId,
        top: anchor.getBoundingClientRect().top - viewportRect.top,
      },
      anchorTop: (id: string) => {
        const target = [...root.querySelectorAll<HTMLElement>("[data-thread-progressive-window-chunk]")]
          .find(element => element.dataset.threadProgressiveWindowChunk === id);
        return target ? target.getBoundingClientRect().top - scrollTarget.getBoundingClientRect().top : null;
      },
      hiddenCount: visibleStartRef.current,
      identity: identityToken,
      nearTop: sentinelRect.bottom > viewportRect.top - TOP_MARGIN_PX
        && sentinelRect.top < viewportRect.bottom,
      scrollTop: scrollTarget.scrollTop,
      viewport: scrollTarget,
    };
  }, [identityToken, viewport]);
  const reveal = useCallback((count: number) => {
    setVisibleStart(current => Math.max(0, current - count));
  }, []);
  const writeScrollTop = useCallback((scrollTop: number) => {
    const scrollTarget = viewport.getViewport();
    if (scrollTarget) scrollTarget.scrollTop = scrollTop;
  }, [viewport]);
  const bindingsRef = useRef<ProgressiveWindowOptions>({ readView, reveal, writeScrollTop });
  bindingsRef.current = { readView, reveal, writeScrollTop };
  const controllerRef = useRef<ThreadProgressiveWindowController | null>(null);
  controllerRef.current ??= new ThreadProgressiveWindowController({
    readView: () => bindingsRef.current.readView(),
    reveal: count => bindingsRef.current.reveal(count),
    writeScrollTop: scrollTop => bindingsRef.current.writeScrollTop(scrollTop),
  });

  useLayoutEffect(() => {
    controllerRef.current?.reconcile();
  });
  useEffect(() => {
    const scrollTarget = viewport.getViewport();
    const sentinel = sentinelRef.current;
    if (!scrollTarget || !sentinel) return;
    const reconcile = () => controllerRef.current?.reconcile();
    const observer = new IntersectionObserver(reconcile, {
      root: scrollTarget,
      rootMargin: `${TOP_MARGIN_PX}px 0px 0px`,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [viewport]);
  const visibleChunks = chunks.slice(boundedStart);
  return (
    <div ref={rootRef} className="space-y-2" data-thread-progressive-window={identity}>
      <div ref={sentinelRef} className="h-px" aria-hidden />
      {visibleChunks.map(chunk => (
        <div key={chunk.key} data-thread-progressive-window-chunk={chunk.key}>
          {chunk.content}
        </div>
      ))}
    </div>
  );
}

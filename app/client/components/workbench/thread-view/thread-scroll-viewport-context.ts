/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, scroll correction, progressive-window and end controls, entry motion, worked-run state, and layout preservation.
 * - useThreadScrollViewportContext: read the nearest viewport boundary without host prop drilling.
 * - ThreadEntryMotion: apply one admitted entry's motion state to caller-owned markup.
 */

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import type ThreadEntryMotionController from "./ThreadEntryMotionController";
import type ThreadWorkedRunController from "./ThreadWorkedRunController";
import type {
  ThreadContentVisibility,
  ThreadContentVisibilityRange,
} from "./ThreadViewportVisibilityController";

export interface ThreadScrollViewportContextValue {
  readonly entryMotion: ThreadEntryMotionController | null;
  readonly workedRunState: ThreadWorkedRunController | null;
  readonly progressiveWindowing: boolean;
  /** Revealed start per progressive window identity, so a windowed remount restores its measured height. */
  readonly progressiveWindowStarts: Map<string, number> | null;
  readonly getViewport: () => HTMLDivElement | null;
  /** Keep the reader's visual position after layout above them changed by `delta` px. The one scroll-correction path. */
  readonly shiftScrollTop: (delta: number) => void;
  readonly observeContent: (
    element: HTMLElement,
    listener: (state: ThreadContentVisibility) => void,
    range?: ThreadContentVisibilityRange,
    preserveReadingPosition?: boolean,
  ) => () => void;
  readonly preserveOffscreenLayout: () => () => void;
  readonly setEndTarget: (target: HTMLElement | null) => void;
  readonly onBottomReattached: (listener: () => void) => () => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  entryMotion: null,
  workedRunState: null,
  progressiveWindowing: false,
  progressiveWindowStarts: null,
  getViewport: () => null,
  shiftScrollTop: () => {},
  observeContent: () => () => {},
  preserveOffscreenLayout: () => () => {},
  setEndTarget: () => {},
  onBottomReattached: () => () => {},
};

export const ThreadScrollViewportContext = createContext<ThreadScrollViewportContextValue>(
  DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT,
);

export function useThreadScrollViewportContext() {
  return useContext(ThreadScrollViewportContext);
}

export function ThreadEntryMotion({
  children,
  enabled,
  identity,
}: {
  children: (animate: boolean) => ReactNode;
  enabled: boolean;
  identity: string;
}) {
  const controller = useThreadScrollViewportContext().entryMotion;
  const animateRef = useRef(false);
  if (!animateRef.current && enabled && controller?.shouldAnimate(identity)) {
    animateRef.current = true;
  }
  useLayoutEffect(() => {
    if (animateRef.current) controller?.commit(identity);
  }, [controller, identity]);
  return children(animateRef.current);
}

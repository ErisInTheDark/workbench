/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, content visibility, progressive-window, reader-movement and end controls (including revealing the end), entry motion, and activity-run open state.
 * - useThreadScrollViewportContext: read the nearest viewport boundary without host prop drilling.
 * - ThreadEntryMotion: apply one admitted entry's motion state to caller-owned markup.
 */

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import type ThreadEntryMotionController from "./ThreadEntryMotionController";
import type ThreadActivityRunController from "./ThreadActivityRunController";
import type {
  ThreadContentVisibility,
  ThreadContentVisibilityRange,
} from "./ThreadViewportVisibilityController";

export interface ThreadScrollViewportContextValue {
  readonly entryMotion: ThreadEntryMotionController | null;
  readonly activityRuns: ThreadActivityRunController | null;
  readonly progressiveWindowing: boolean;
  /** First revealed chunk key per progressive window identity, so a windowed remount restores its measured height. */
  readonly progressiveWindowStarts: Map<string, string> | null;
  readonly getViewport: () => HTMLDivElement | null;
  /** Put the reader back after a commit changed layout, now; call before reading geometry in a layout effect. */
  readonly reconcileLayout: () => void;
  readonly observeContent: (
    element: HTMLElement,
    listener: (state: ThreadContentVisibility) => void,
    range?: ThreadContentVisibilityRange,
  ) => () => void;
  readonly setEndTarget: (target: HTMLElement | null) => void;
  /** Glide the reader to the end and follow it, docking end chrome such as the compact control. */
  readonly revealEnd: () => void;
  readonly onBottomReattached: (listener: () => void) => () => void;
  /** Notified after every scroll and every corrected layout change, so reach checks never wait on a threshold crossing. */
  readonly onReaderMoved: (listener: () => void) => () => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  entryMotion: null,
  activityRuns: null,
  progressiveWindowing: false,
  progressiveWindowStarts: null,
  getViewport: () => null,
  reconcileLayout: () => {},
  observeContent: () => () => {},
  setEndTarget: () => {},
  revealEnd: () => {},
  onBottomReattached: () => () => {},
  onReaderMoved: () => () => {},
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

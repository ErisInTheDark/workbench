/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, content visibility, progressive-window, reader-movement and end controls, entry motion, and worked-run state.
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
  readonly onBottomReattached: (listener: () => void) => () => void;
  /** Notified after every scroll and every corrected layout change, so reach checks never wait on a threshold crossing. */
  readonly onReaderMoved: (listener: () => void) => () => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  entryMotion: null,
  workedRunState: null,
  progressiveWindowing: false,
  progressiveWindowStarts: null,
  getViewport: () => null,
  reconcileLayout: () => {},
  observeContent: () => () => {},
  setEndTarget: () => {},
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

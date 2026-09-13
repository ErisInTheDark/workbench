/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, committed end target, and off-screen layout preservation.
 * - useThreadScrollViewportContext: read the nearest viewport boundary without host prop drilling.
 */

import { createContext, useContext } from "react";

export interface ThreadScrollViewportContextValue {
  readonly getViewport: () => HTMLDivElement | null;
  readonly preserveOffscreenLayout: () => () => void;
  readonly setEndTarget: (target: HTMLElement | null) => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  getViewport: () => null,
  preserveOffscreenLayout: () => () => {},
  setEndTarget: () => {},
};

export const ThreadScrollViewportContext = createContext<ThreadScrollViewportContextValue>(
  DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT,
);

export function useThreadScrollViewportContext() {
  return useContext(ThreadScrollViewportContext);
}

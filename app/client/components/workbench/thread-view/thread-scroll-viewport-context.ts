/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, end target, bottom-return notifications, and layout preservation.
 * - useThreadScrollViewportContext: read the nearest viewport boundary without host prop drilling.
 */

import { createContext, useContext } from "react";
import type { ThreadContentVisibility } from "./ThreadViewportVisibilityController";

export interface ThreadScrollViewportContextValue {
  readonly getViewport: () => HTMLDivElement | null;
  readonly observeContent: (element: HTMLElement, listener: (state: ThreadContentVisibility) => void) => () => void;
  readonly preserveOffscreenLayout: () => () => void;
  readonly setEndTarget: (target: HTMLElement | null) => void;
  readonly onBottomReattached: (listener: () => void) => () => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  getViewport: () => null,
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

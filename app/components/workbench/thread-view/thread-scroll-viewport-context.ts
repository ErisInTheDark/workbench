/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: nearest viewport, off-screen layout preservation and composer intent.
 * - useThreadScrollViewportContext: read the nearest viewport intent boundary without host prop drilling. Keywords: thread, scroll viewport, React context.
 */

import { createContext, useContext } from "react";

export interface ThreadScrollViewportContextValue {
  readonly getViewport: () => HTMLDivElement | null;
  readonly preserveOffscreenLayout: () => () => void;
  readonly isWithinBottomDistance: (tolerancePx: number) => boolean;
  readonly reportComposerArmed: (armed: boolean) => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  getViewport: () => null,
  preserveOffscreenLayout: () => () => {},
  isWithinBottomDistance: () => false,
  reportComposerArmed: () => undefined,
};

export const ThreadScrollViewportContext = createContext<ThreadScrollViewportContextValue>(
  DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT,
);

export function useThreadScrollViewportContext() {
  return useContext(ThreadScrollViewportContext);
}

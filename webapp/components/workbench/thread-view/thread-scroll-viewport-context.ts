/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: the nearest thread viewport's composer-arming and bottom-distance boundary. Keywords: thread, scroll viewport, composer, context.
 * - useThreadScrollViewportContext: read the nearest viewport intent boundary without host prop drilling. Keywords: thread, scroll viewport, React context.
 */

import { createContext, useContext } from "react";

export interface ThreadScrollViewportContextValue {
  readonly isWithinBottomDistance: (tolerancePx: number) => boolean;
  readonly reportComposerArmed: (armed: boolean) => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  isWithinBottomDistance: () => false,
  reportComposerArmed: () => undefined,
};

export const ThreadScrollViewportContext = createContext<ThreadScrollViewportContextValue>(
  DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT,
);

export function useThreadScrollViewportContext() {
  return useContext(ThreadScrollViewportContext);
}

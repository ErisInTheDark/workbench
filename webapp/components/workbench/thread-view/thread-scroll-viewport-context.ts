/*
 * Exports:
 * - ThreadScrollViewportContextValue/ThreadScrollViewportContext: the nearest thread viewport's composer-arming intent boundary. Keywords: thread, scroll viewport, composer, context.
 * - useThreadScrollViewportContext: read the nearest viewport intent boundary without host prop drilling. Keywords: thread, scroll viewport, React context.
 */

import { createContext, useContext } from "react";

export interface ThreadScrollViewportContextValue {
  readonly reportComposerArmed: (armed: boolean) => void;
  readonly reportComposerGeometryChange: () => void;
}

const DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT: ThreadScrollViewportContextValue = {
  reportComposerArmed: () => undefined,
  reportComposerGeometryChange: () => undefined,
};

export const ThreadScrollViewportContext = createContext<ThreadScrollViewportContextValue>(
  DEFAULT_THREAD_SCROLL_VIEWPORT_CONTEXT,
);

export function useThreadScrollViewportContext() {
  return useContext(ThreadScrollViewportContext);
}

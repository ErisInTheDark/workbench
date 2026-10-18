/*
 * Exports:
 * - default useMediaQuery: whether a CSS media query matches now, re-rendering when it changes.
 */
import { useCallback, useSyncExternalStore } from "react";

function mediaQueryList(query: string) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

export default function useMediaQuery(query: string) {
  const subscribe = useCallback((listener: () => void) => {
    const list = mediaQueryList(query);
    if (!list) return () => {};
    list.addEventListener("change", listener);
    return () => { list.removeEventListener("change", listener); };
  }, [query]);
  const read = useCallback(() => mediaQueryList(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, read, () => false);
}

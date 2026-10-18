/*
 * Exports:
 * - default useSearchHighlight: paint a query's matches over the text under an element, following its DOM as it re-renders.
 */
"use client";

import { useEffect, useMemo } from "react";
import { createHighlightScope } from "../dom/css-highlights";
import { TextSearch } from "./text-search";

/** Pairs with `::highlight(search-match)` in the app stylesheet. */
const SEARCH_MATCH = "search-match";

function matchRanges(root: HTMLElement, search: TextSearch) {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of TextSearch.ranges(search, node.textContent ?? "")) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Matches spanning separately rendered text, such as plain words around bold ones, still filter but are not painted. */
export default function useSearchHighlight(root: HTMLElement | null, query: string) {
  const search = useMemo(() => TextSearch.parse(query), [query]);
  useEffect(() => {
    if (!root || !search.include.length) return;
    const scope = createHighlightScope<typeof SEARCH_MATCH>();
    let frame = 0;
    const paint = () => {
      frame = 0;
      scope.set(SEARCH_MATCH, matchRanges(root, search));
    };
    paint();
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(paint);
    });
    observer.observe(root, { characterData: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scope.clear();
    };
  }, [root, search]);
}

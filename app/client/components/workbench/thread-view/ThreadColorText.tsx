/*
 * Exports:
 * - default ThreadColorText: paint agent-authored `<color>` tag content in its resolved colour; an unreadable colour leaves it plain.
 */

import type { ReactNode } from "react";

import type { ThreadTextColor } from "../../../workbench/markdown/thread-emphasis-markup";
import { getThreadTextColorStyle } from "./thread-markdown-emphasis-colors";

export default function ThreadColorText ({ children, color }: { children: ReactNode; color: ThreadTextColor | null }) {
  const paint = color === null ? null : getThreadTextColorStyle(color);
  return (
    <span className={paint?.className} data-thread-color={color ?? undefined} style={paint?.style}>
      {children}
    </span>
  );
}

/*
 * Exports:
 * - default ThreadScrollViewport: own the reverse-flex scrollport that keeps chronological thread content anchored at the bottom. Keywords: thread, scroll, viewport, reverse flex, bottom anchor.
 */
"use client";

import { forwardRef, type ReactNode } from "react";

function joinClasses (...values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const ThreadScrollViewport = forwardRef<HTMLDivElement, {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  enabled?: boolean;
  resetKey: string;
}>(function ThreadScrollViewport ({
  children,
  className,
  contentClassName,
  enabled = true,
  resetKey,
}, ref) {
  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <div
      key={resetKey}
      ref={ref}
      className={joinClasses(
        "explorer-scrollbar flex min-h-0 flex-col-reverse overflow-x-hidden overflow-y-auto",
        className,
      )}
      data-thread-scroll-target="true"
    >
      <div className={joinClasses("min-h-full shrink-0", contentClassName)}>
        {children}
      </div>
    </div>
  );
});

ThreadScrollViewport.displayName = "ThreadScrollViewport";

export default ThreadScrollViewport;

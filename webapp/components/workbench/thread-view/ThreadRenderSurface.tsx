/*
 * Exports:
 * - default ThreadRenderSurface: render a ThreadPayload through the chrome-free Workbench thread renderer. Keywords: thread, standalone, render lab, command matcher.
 */
"use client";

import type { CSSProperties } from "react";

import type { ThreadPayload, WorkbenchProjectRoot } from "../../../lib/types";
import { ThreadThreadContent } from "./thread-view-items";

function createThreadProjectRoots(thread: ThreadPayload | null | undefined): WorkbenchProjectRoot[] {
  if (!thread?.cwd) {
    return [];
  }

  return [{
    id: "thread-cwd",
    isPrimary: true,
    name: "Thread cwd",
    relativePath: "",
    rootPath: thread.cwd,
  }];
}

export default function ThreadRenderSurface({
  className = "",
  emptyMessage = "No thread activity was captured yet.",
  flattenCompletedWork = false,
  fontSizeRem = 1,
  thread,
}: {
  className?: string;
  emptyMessage?: string;
  flattenCompletedWork?: boolean;
  fontSizeRem?: number;
  thread: ThreadPayload | null | undefined;
}) {
  const projectRoots = createThreadProjectRoots(thread);
  const style = {
    fontSize: `${fontSizeRem}rem`,
  } satisfies CSSProperties;

  return (
    <div
      className={`mx-auto w-full min-w-0 max-w-[56rem] overflow-x-hidden px-5 py-8 text-text md:px-6 ${className}`}
      data-standalone-thread-render-surface="true"
      style={style}
    >
      <ThreadThreadContent
        browseScreenshotEntries={thread?.browseScreenshotEntries ?? []}
        emptyMessage={emptyMessage}
        flattenCompletedWork={flattenCompletedWork}
        hideWorkbenchControlAgentMessages
        hideWorkbenchControlUserMessages
        knownSkills={[]}
        projectRootPath={thread?.cwd}
        projectRoots={projectRoots}
        thread={thread}
        threadCwdPath={thread?.cwd}
      />
    </div>
  );
}

"use client";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadMarkdown from "./ThreadMarkdown";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadReasoningItem ({
  className,
  item,
  onOpenFile,
  projectRootPath,
}: {
  className?: string;
  item: Extract<ThreadItem, { type: "reasoning" }>;
  onOpenFile?: (path: string) => Promise<void>;
  projectRootPath?: string;
}) {
  return (
    <section className={joinClasses("space-y-2", className)}>
      {...item.summary.map((summaryMarkdown, i) => (
        <ThreadMarkdown
          key={i}
          markdown={summaryMarkdown.replaceAll(/\n\n/g, "\n").trim()}
          onOpenFile={onOpenFile}
          projectRootPath={projectRootPath}
          className="text-[0.8em] text-muted"
        />
      ))}
    </section>
  );
}

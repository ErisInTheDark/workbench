/*
 * Exports:
 * - default ThreadContextCommandItem: render a Thread Recall command or context alias as a semantic Markdown disclosure. Keywords: thread recall, context, markdown, disclosure.
 * - Local helpers: format command execution metadata for the Thread Recall disclosure summary. Keywords: status, duration, exit code.
 */
"use client";

import type { ReactNode } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { WorkspaceFileLinkRoot } from "../../../lib/workbench/markdown/markdown-links";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadSummaryText from "./ThreadSummaryText";
import { humanizeThreadLabel } from "./thread-view-primitives";

type CommandItem = Extract<ThreadItem, { type: "commandExecution" }>;

function ThreadContextCommandMetaParts({ item }: { item: CommandItem }) {
  const metaParts: ReactNode[] = [];

  if (item.status !== "completed") {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:status`}
        text={humanizeThreadLabel(item.status)}
      />,
    );
  }

  if (item.exitCode !== null && item.exitCode !== 0) {
    metaParts.push(
      <ThreadSummaryText
        key={`${item.id}:exit`}
        text={`exit ${item.exitCode}`}
      />,
    );
  }

  if (item.durationMs !== null) {
    metaParts.push(
      <ThreadDurationText
        key={`${item.id}:duration`}
        durationMs={item.durationMs}
      />,
    );
  }

  if (!metaParts.length) {
    return null;
  }

  return (
    <span className="ml-2 text-[0.78em] text-muted">
      {metaParts.map((part, index) => (
        <span key={`${item.id}:meta:${index}`}>
          {index ? <span className="text-muted"> | </span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

export default function ThreadContextCommandItem ({
  defaultOpen = false,
  item,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadCwdPath,
  workspaceRoots,
}: {
  defaultOpen?: boolean;
  item: CommandItem;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadCwdPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const markdown = item.aggregatedOutput?.trim() ?? "";

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2"
      defaultOpen={defaultOpen}
      summary={(
        <>
          <span className="font-medium text-text">Recalled thread history</span>
          <ThreadContextCommandMetaParts item={item} />
        </>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadPreviewFrame
        backgroundClassName="before:bg-[linear-gradient(to_right,transparent,#8882_10%,#8882_90%,transparent)]"
        contentClassName="mb-8 px-4 py-8"
        edgeBleed="wide"
        edgeOffset="none"
        mode="panel"
      >
        {markdown ? (
          <ThreadMarkdown
            markdown={markdown}
            projectFilePaths={projectFilePaths}
            projectId={projectId}
            projectRootPath={projectRootPath}
            threadCwdPath={threadCwdPath ?? item.cwd}
            workspaceRoots={workspaceRoots}
          />
        ) : (
          <p className="m-0 text-[0.92em] leading-[1.6] text-muted">No Thread Recall output captured.</p>
        )}
      </ThreadPreviewFrame>
    </ThreadDisclosure>
  );
}

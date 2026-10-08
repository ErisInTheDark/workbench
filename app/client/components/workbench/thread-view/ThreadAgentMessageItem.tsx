/*
 * Exports:
 * - default ThreadAgentMessageItem: render a sent cross-thread message as a disclosure naming the target thread button, with a left-aligned user-style bubble.
 * - ThreadAgentMessageTarget: render a sent message's resolved destination name or thread link.
 * - ThreadAgentMessageBubble: render only the sent-message bubble, optionally with destination attribution.
 * - ThreadAgentMessageClaimRelease: append a compact expandable released-file list to a sent-message bubble.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { RelatedThread } from "../../../workbench/thread/ThreadStore";
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { isProjectDirectoryPath } from "../../../workbench/project/project-file-path";

import ProjectFilePath from "../ProjectFilePath";
import WorkbenchThreadButton from "../WorkbenchThreadButton";
import { EllipsisIcon, SquareArrowRightEnterIcon } from "../workbench-icons";
import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

interface ThreadAgentMessageTargetProps {
  fallbackName?: string | null;
  subagent?: WorkbenchSubagentSummary | null;
  /** The messaged thread, or `parent` of the messaging subagent; shown as a thread button once loaded. */
  target?: { relation: "self" | "parent"; threadId: string } | null;
  thread?: RelatedThread | null;
}

export function ThreadAgentMessageTarget({
  fallbackName,
  subagent,
  target,
  thread,
}: ThreadAgentMessageTargetProps) {
  const name = (
    <ThreadAgentName
      subagent={subagent}
      thread={thread ?? (fallbackName ? { agentNickname: fallbackName, agentRole: null } : null)}
    />
  );
  return target
    ? <WorkbenchThreadButton fallback={name} label={subagent ? name : undefined} relation={target.relation} threadId={target.threadId} />
    : name;
}

export function ThreadAgentMessageBubble({
  children,
  recipient,
}: {
  children: ReactNode;
  recipient?: ReactNode;
}) {
  return (
    <ThreadSubagentUserMessage>
      {recipient ? (
        <div className="space-y-1.5">
          <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-[0.78em] font-medium leading-[1.5] text-fg/muted">
            <span>Messaged</span>
            {recipient}
          </p>
          {children}
        </div>
      ) : children}
    </ThreadSubagentUserMessage>
  );
}

export function ThreadAgentMessageClaimRelease({
  paths,
  projectFilePaths,
  projectId,
  projectRootPath,
  workspaceRoots,
}: {
  paths: readonly string[];
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visiblePaths = showAll ? paths : paths.slice(0, 3);
  if (!paths.length) return null;
  return (
    <p className="m-0 mt-2 flex flex-wrap items-center gap-1.5 text-[0.78em] leading-[1.5] text-fg/muted">
      <span className="inline-flex shrink-0" aria-hidden="true">
        <SquareArrowRightEnterIcon size={16} />
      </span>
      {visiblePaths.map((filePath) => {
        const displayPath = toWorkspaceDisplayPath(filePath, {
          projectRootPath: projectRootPath ?? "",
          workspaceRoots,
        }) ?? filePath;
        return (
          <ProjectFilePath
            className="min-w-0 max-w-full"
            disambiguationPaths={projectFilePaths}
            key={filePath}
            path={displayPath}
            projectId={projectId}
            targetType={isProjectDirectoryPath(displayPath, projectFilePaths ?? []) ? "directory" : "file"}
          />
        );
      })}
      {paths.length > 3 ? (
        <button
          type="button"
          aria-expanded={showAll}
          aria-label={showAll ? "Show fewer released files" : "Show all released files"}
          className="inline-flex size-6 items-center justify-center rounded-full text-fg/muted transition-colors hover:bg-fg/7 hover:text-text focus-visible:bg-fg/7 focus-visible:text-text focus-visible:outline-none motion-reduce:transition-none"
          onClick={() => setShowAll((current) => !current)}
          title={showAll ? "Show fewer released files" : "Show all released files"}
        >
          <EllipsisIcon size={16} />
        </button>
      ) : null}
    </p>
  );
}

export default function ThreadAgentMessageItem ({
  children,
  ...targetProps
}: ThreadAgentMessageTargetProps & {
  children: ReactNode;
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={(
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <span>Messaged</span>
          <ThreadAgentMessageTarget {...targetProps} />
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadAgentMessageBubble>{children}</ThreadAgentMessageBubble>
    </ThreadDisclosure>
  );
}

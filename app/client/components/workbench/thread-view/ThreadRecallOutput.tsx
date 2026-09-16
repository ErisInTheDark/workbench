/*
 * Exports:
 * - default ThreadRecallOutput: lazily render measured Recall records and preserve Markdown fallback.
 */
"use client";

import { type ReactNode } from "react";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  parseWorkbenchThreadRecallOutput,
  type WorkbenchThreadRecallOutputRecord,
} from "../../../workbench/thread/thread-recall-output";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadSummaryText from "./ThreadSummaryText";
import ThreadMeasuredContent from "./ThreadMeasuredContent";

function RecallRecord({ record, index, renderRecord }: {
  record: WorkbenchThreadRecallOutputRecord;
  index: number;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
}) {
  return renderRecord(record, index);
}

function ThreadRecallQuestionnaire({
  record,
  projectFilePaths,
  projectId,
  projectRootPath,
  threadCwdPath,
  workspaceRoots,
}: {
  record: WorkbenchThreadRecallOutputRecord;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  threadCwdPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadSummaryText text="Questionnaire response" />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadMarkdown
        markdown={record.text}
        projectFilePaths={projectFilePaths}
        projectId={projectId}
        projectRootPath={projectRootPath}
        threadCwdPath={threadCwdPath}
        workspaceRoots={workspaceRoots}
      />
    </ThreadDisclosure>
  );
}

export default function ThreadRecallOutput({
  markdown,
  projectFilePaths,
  projectId,
  projectRootPath,
  renderRecord,
  threadCwdPath,
  workspaceRoots,
}: {
  markdown: string;
  projectFilePaths?: readonly string[];
  projectId?: string | null;
  projectRootPath?: string;
  renderRecord: (record: WorkbenchThreadRecallOutputRecord, index: number) => ReactNode;
  threadCwdPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}) {
  const segments = parseWorkbenchThreadRecallOutput(markdown);
  return (
    <div className="space-y-2">
      {segments.map((segment, index) => {
        if (segment.type === "markdown") {
          return (
            <ThreadMeasuredContent key={`markdown:${index}`}>
            <ThreadMarkdown
              markdown={segment.markdown}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              threadCwdPath={threadCwdPath}
              workspaceRoots={workspaceRoots}
            />
            </ThreadMeasuredContent>
          );
        }
        if (segment.record.kind === "questionnaire") {
          return (
            <ThreadRecallQuestionnaire
              key={`record:${segment.record.ref}:${index}`}
              record={segment.record}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              threadCwdPath={threadCwdPath}
              workspaceRoots={workspaceRoots}
            />
          );
        }
        return (
          <ThreadMeasuredContent key={`record:${segment.record.ref}:${index}`}>
            <RecallRecord record={segment.record} index={index} renderRecord={renderRecord} />
          </ThreadMeasuredContent>
        );
      })}
    </div>
  );
}

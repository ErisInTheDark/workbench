/*
 * Exports:
 * - default ThreadRecallOutput: segment tagged Thread Recall records, delegate canonical record rendering, and preserve Markdown fallback. Keywords: thread recall, renderer, delegation, fallback.
 * - Local helpers: render semantic questionnaire responses that cannot reconstruct structured interactive requests. Keywords: questionnaire, response, disclosure.
 */
"use client";

import { Fragment, type ReactNode } from "react";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  parseWorkbenchThreadRecallOutput,
  type WorkbenchThreadRecallOutputRecord,
} from "../../../workbench/thread/thread-recall-output";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadSummaryText from "./ThreadSummaryText";

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
            <ThreadMarkdown
              key={`markdown:${index}`}
              markdown={segment.markdown}
              projectFilePaths={projectFilePaths}
              projectId={projectId}
              projectRootPath={projectRootPath}
              threadCwdPath={threadCwdPath}
              workspaceRoots={workspaceRoots}
            />
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
          <Fragment key={`record:${segment.record.ref}:${index}`}>
            {renderRecord(segment.record, index)}
          </Fragment>
        );
      })}
    </div>
  );
}

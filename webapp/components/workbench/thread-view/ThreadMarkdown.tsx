"use client";

import { memo, useMemo, type MouseEvent } from "react";

import {
  parseCodexFileLinkHref,
  toProjectRelativeFilePath,
} from "../../../lib/workbench/markdown/markdown-links";
import type { WorkbenchFileOpenTarget } from "../../../lib/types";
import type { InlineMentionHighlightSources } from "../../../lib/workbench/thread/inline-mention-highlights";
import { renderThreadMarkdown } from "./thread-markdown-render";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

const THREAD_MARKDOWN_CLASS = [
  "min-w-0",
  "max-w-full",
  "leading-[1.72]",
  "[&:not(:first-child)]:mt-[0.2rem]",
].join(" ");

function readPositiveIntegerDatasetValue(value: string | undefined) {
  const numericValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : null;
}

export default memo(function ThreadMarkdown ({
  className,
  inlineMentionSources,
  markdown,
  onOpenFile,
  projectRootPath,
}: {
  className?: string;
  inlineMentionSources?: InlineMentionHighlightSources | null;
  markdown: string;
  onOpenFile?: (target: WorkbenchFileOpenTarget) => Promise<void>;
  projectRootPath?: string;
}) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) {
      return;
    }

    if (!(event.target instanceof Element)) {
      return;
    }

    const anchor = event.target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const rawHref = anchor.getAttribute("href");
    const inlineRelativePath = anchor.dataset.projectFileRelativePath?.trim();
    if (inlineRelativePath && onOpenFile) {
      event.preventDefault();
      void onOpenFile({
        columnNumber: readPositiveIntegerDatasetValue(anchor.dataset.projectFileColumnNumber),
        lineNumber: readPositiveIntegerDatasetValue(anchor.dataset.projectFileLineNumber),
        path: inlineRelativePath,
      });
      return;
    }

    if (!rawHref) {
      return;
    }

    const fileLink = parseCodexFileLinkHref(rawHref);
    if (!fileLink) {
      return;
    }

    const relativePath = toProjectRelativeFilePath(fileLink.absolutePath, projectRootPath ?? "");
    if (!relativePath || !onOpenFile) {
      return;
    }

    event.preventDefault();
    void onOpenFile({
      columnNumber: fileLink.columnNumber,
      lineNumber: fileLink.lineNumber,
      path: relativePath,
    });
  };

  const renderedMarkdown = useMemo(
    () => renderThreadMarkdown(markdown, { inlineMentionSources, projectRootPath }),
    [inlineMentionSources, markdown, projectRootPath],
  );

  return (
    <div
      className={joinClasses(THREAD_MARKDOWN_CLASS, className)}
      onClick={handleClick}
    >
      {renderedMarkdown}
    </div>
  );
});

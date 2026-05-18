"use client";

import { memo, useMemo, type MouseEvent } from "react";

import {
  parseCodexFileLinkHref,
  toProjectRelativeFilePath,
} from "../../../lib/workbench/markdown/markdown-links";
import { markdownToHtml } from "../../../lib/workbench/markdown/markdown-render";

function joinClasses (...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

const THREAD_MARKDOWN_CLASS = [
  "leading-[1.72]",
  "[&:not(:first-child)]:mt-[0.2rem]",
  "[&_p]:mb-[0.9em]",
  "[&_blockquote]:mb-[0.9em]",
  "[&_ul]:mb-[0.9em]",
  "[&_ol]:mb-[0.9em]",
  "[&_pre]:mb-[0.9em]",
  "[&_h1]:mb-[0.9em]",
  "[&_h2]:mb-[0.9em]",
  "[&_h3]:mb-[0.9em]",
  "[&_h4]:mb-[0.9em]",
  "[&_h5]:mb-[0.9em]",
  "[&_h6]:mb-[0.9em]",
  "[&>*:last-child]:mb-0",
  "[&_h1]:font-sans [&_h1]:text-[1.16em] [&_h1]:font-semibold [&_h1]:leading-[1.2]",
  "[&_h2]:font-sans [&_h2]:text-[1.08em] [&_h2]:font-semibold [&_h2]:leading-[1.2]",
  "[&_h3]:font-sans [&_h3]:text-[1em] [&_h3]:font-semibold [&_h3]:leading-[1.2]",
  "[&_h4]:font-sans [&_h4]:text-[1em] [&_h4]:font-semibold [&_h4]:leading-[1.2]",
  "[&_h5]:font-sans [&_h5]:text-[1em] [&_h5]:font-semibold [&_h5]:leading-[1.2]",
  "[&_h6]:font-sans [&_h6]:text-[1em] [&_h6]:font-semibold [&_h6]:leading-[1.2]",
  "[&_[data-thread-step-line='true']]:mb-[0.55em] [&_[data-thread-step-line='true']]:font-sans [&_[data-thread-step-line='true']]:text-[1em] [&_[data-thread-step-line='true']]:font-semibold [&_[data-thread-step-line='true']]:leading-[1.25]",
  "[&_[data-thread-step-marker='true']]:mr-[0.22em] [&_[data-thread-step-marker='true']]:text-muted",
  "[&_ul]:list-disc [&_ul]:pl-[1.3rem]",
  "[&_ol]:list-decimal [&_ol]:pl-[1.3rem]",
  "[&_li+li]:mt-1",
  "[&_blockquote]:border-l-[0.18rem] [&_blockquote]:[border-left-color:color-mix(in_srgb,var(--text)_14%,transparent)] [&_blockquote]:pl-[0.9rem] [&_blockquote]:text-muted",
  "[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent-soft [&_a]:decoration-[0.08em] [&_a]:underline-offset-[0.16em]",
  "[&_a[data-project-file-path='true']]:text-text [&_a[data-project-file-path='true']]:no-underline [&_a[data-project-file-path='true']]:decoration-transparent",
  "[&_code]:rounded-[0.35rem] [&_code]:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] [&_code]:px-[0.34em] [&_code]:py-[0.08em] [&_code]:font-mono [&_code]:text-[0.94em]",
  "[&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-[0.9rem] [&_pre]:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [&_pre]:px-[0.95rem] [&_pre]:py-[0.8rem]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none",
  "[&_[data-block-comment='true']]:mx-0 [&_[data-block-comment='true']]:rounded-[0.6rem] [&_[data-block-comment='true']]:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [&_[data-block-comment='true']]:px-[0.75rem] [&_[data-block-comment='true']]:py-[0.55rem] [&_[data-block-comment='true']]:text-[0.9em] [&_[data-block-comment='true']]:text-[color:color-mix(in_srgb,var(--text)_60%,transparent)]",
  "[&_[data-inline-comment='true']]:rounded-[0.35rem] [&_[data-inline-comment='true']]:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [&_[data-inline-comment='true']]:px-[0.34em] [&_[data-inline-comment='true']]:py-[0.08em] [&_[data-inline-comment='true']]:text-[color:color-mix(in_srgb,var(--text)_60%,transparent)]",
  "[&_ins]:-mx-[0.04em] [&_ins]:rounded-[0.2em] [&_ins]:bg-[color-mix(in_srgb,var(--success)_16%,transparent)] [&_ins]:px-[0.08em] [&_ins]:text-inherit [&_ins]:no-underline",
  "[&_del]:-mx-[0.04em] [&_del]:rounded-[0.2em] [&_del]:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] [&_del]:px-[0.08em] [&_del]:text-inherit [&_del]:decoration-current [&_del]:decoration-[0.08em]",
].join(" ");

export default memo(function ThreadMarkdown ({
  className,
  markdown,
  onOpenFile,
  projectRootPath,
}: {
  className?: string;
  markdown: string;
  onOpenFile?: (path: string) => Promise<void>;
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
    void onOpenFile(relativePath);
  };

  const renderedHtml = useMemo(
    () => markdownToHtml(markdown, { profile: "thread", projectRootPath }),
    [markdown, projectRootPath],
  );

  return (
    <div
      className={joinClasses(THREAD_MARKDOWN_CLASS, className)}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
      onClick={handleClick}
    />
  );
});

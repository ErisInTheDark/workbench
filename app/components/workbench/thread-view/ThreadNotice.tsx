/*
 * Exports:
 * - default ThreadNotice: render one titled agent-authored notice with Markdown body content. Keywords: thread, markdown, notice, callout, color.
 */

import type { ReactNode } from "react";

import { CircleAlertIcon } from "../workbench-icons";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

export default function ThreadNotice ({ bodyMarkdown, children, color, source, title }: {
  bodyMarkdown: string;
  children: ReactNode;
  color: string;
  source: string;
  title: string;
}) {
  const colors = getThreadMarkdownEmphasisColors(color);
  if (!colors || !title || !bodyMarkdown.trim()) {
    return <p className="mb-[0.9em] whitespace-pre-wrap last:mb-0">{source}</p>;
  }

  const toneClassName = colors.text;

  return (
    <aside
      aria-label={title}
      className={`relative mb-[0.9em] overflow-hidden px-[0.95rem] py-[0.8rem] pl-[1.05rem] last:mb-0 ${colors.background}`}
      data-thread-notice="true"
      data-thread-notice-color={color}
      role="note"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[0.22rem] bg-current ${toneClassName}`}
      />
      <div
        className={`flex items-center gap-[0.35rem] font-sans text-[0.9em] font-semibold leading-[1.4] ${toneClassName}`}
        data-thread-notice-title="true"
      >
        <span className="inline-flex shrink-0" data-thread-notice-icon="alert">
          <CircleAlertIcon className="size-[1em]" />
        </span>
        <span>{title}</span>
      </div>
      <div className="mt-[0.45rem]" data-thread-notice-body="true">
        {children}
      </div>
    </aside>
  );
}

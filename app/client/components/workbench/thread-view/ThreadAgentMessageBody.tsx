/*
 * Exports:
 * - ThreadAgentMessageBodyPart: one cross-agent message's full markdown and optional user-visible simple version.
 * - default ThreadAgentMessageBody: show one or more cross-agent messages by their user-visible simple versions, toggling them all to full markdown on click; full markdown when none has a simple version.
 */
"use client";

import { useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react";

import ThreadMarkdown from "./ThreadMarkdown";

export interface ThreadAgentMessageBodyPart {
  markdown: string;
  userVisibleSimpleVersion?: string | null;
}

export default function ThreadAgentMessageBody({
  parts,
  ...markdownProps
}: Omit<ComponentProps<typeof ThreadMarkdown>, "markdown"> & { parts: readonly ThreadAgentMessageBodyPart[] }) {
  const [isFull, setIsFull] = useState(false);
  // Messages sit a markdown paragraph gap apart in both views, so a bundle reads like one message's paragraphs.
  const fullMarkdown = (
    <div className="space-y-[0.9em]">
      {parts.map((part, index) => <ThreadMarkdown {...markdownProps} key={index} markdown={part.markdown} />)}
    </div>
  );
  if (!parts.some((part) => part.userVisibleSimpleVersion)) return fullMarkdown;
  const toggle = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    // Links and copy controls inside full markdown keep their own behaviour.
    if (event.target instanceof Element && event.target.closest("a, button")) return;
    if ("key" in event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
    }
    setIsFull((current) => !current);
  };
  return (
    <div
      aria-expanded={isFull}
      className="min-w-0 cursor-pointer rounded-md [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={toggle}
      onKeyDown={toggle}
      role="button"
      tabIndex={0}
      title={isFull ? "Show simple version" : "Show full message"}
    >
      {isFull ? fullMarkdown : (
        <div className="space-y-[0.9em]">
          {parts.map((part, index) => part.userVisibleSimpleVersion
            ? <ThreadMarkdown {...markdownProps} key={index} markdown={part.userVisibleSimpleVersion} />
            // A message without a simple version shows in full even in the simple view.
            : <ThreadMarkdown {...markdownProps} key={index} markdown={part.markdown} />)}
        </div>
      )}
    </div>
  );
}

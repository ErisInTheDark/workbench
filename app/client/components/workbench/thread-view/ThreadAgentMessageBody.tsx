/*
 * Exports:
 * - default ThreadAgentMessageBody: show a cross-agent message's user-visible simple version, toggling to the full markdown on click; full markdown when no simple version exists.
 */
"use client";

import { useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react";

import ThreadMarkdown from "./ThreadMarkdown";

export default function ThreadAgentMessageBody({
  markdown,
  userVisibleSimpleVersion,
  ...markdownProps
}: ComponentProps<typeof ThreadMarkdown> & { userVisibleSimpleVersion?: string | null }) {
  const [isFull, setIsFull] = useState(false);
  if (!userVisibleSimpleVersion) return <ThreadMarkdown {...markdownProps} markdown={markdown} />;
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
      {isFull
        ? <ThreadMarkdown {...markdownProps} markdown={markdown} />
        : <p className="m-0 text-[0.92em] leading-[1.6]">{userVisibleSimpleVersion}</p>}
    </div>
  );
}

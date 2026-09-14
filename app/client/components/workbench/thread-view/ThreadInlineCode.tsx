/*
 * Exports:
 * - default ThreadInlineCode: render the shared inline-code surface used throughout thread content. Keywords: thread, inline code, markdown, typography.
 */
import type { ReactNode } from "react";

export default function ThreadInlineCode({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <code
      className={`rounded-[0.35rem] bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-[0.34em] py-[0.08em] font-mono text-[0.94em]${className ? ` ${className}` : ""}`}
      data-thread-inline-code="true"
      title={title}
    >
      {children}
    </code>
  );
}

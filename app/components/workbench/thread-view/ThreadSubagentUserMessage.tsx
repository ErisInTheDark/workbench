/*
 * Exports:
 * - default ThreadSubagentUserMessage: render a subagent-bound user prompt in the shared left-aligned message bubble. Keywords: workbench, thread, subagent, user message, prompt, bubble.
 */
"use client";

import type { ReactNode } from "react";

export default function ThreadSubagentUserMessage ({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col items-start py-2">
      <div className="w-full max-w-[42rem] rounded-[1.15rem] bg-[color-mix(in_srgb,var(--text)_6%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_6%,var(--app-bg-solid))] px-4 py-3 text-left">
        {children}
      </div>
    </section>
  );
}

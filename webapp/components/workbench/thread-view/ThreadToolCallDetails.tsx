/*
 * Exports:
 * - default ThreadToolCallDetails: render a tool invocation and captured output through the ordinary shell-command code surface. Keywords: tool call, input, output, disclosure.
 */
"use client";

import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";

export default function ThreadToolCallDetails({
  invocation,
  output,
}: {
  invocation: string;
  output?: string | null;
}) {
  return (
    <ThreadCodeDisplay
      header={<ThreadCommandHeader command={invocation} surface="framed" />}
      output={output?.trim() || undefined}
      preview
      variant="plain"
    />
  );
}

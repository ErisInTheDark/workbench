/*
 * Exports:
 * - default ThreadCommandDetails: reveal command and output in a nested disclosure with configurable preview height.
 */
"use client";

import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadDisclosure from "./ThreadDisclosure";

export default function ThreadCommandDetails ({
  command,
  output,
  previewHeight = "16rem",
}: {
  command: string;
  output?: string | null;
  previewHeight?: string;
}) {
  return (
    <ThreadDisclosure
      className="py-1"
      contentClassName="pt-1 pl-6"
      summary="Command details"
      summaryClassName="text-[0.9em] leading-[1.55]"
    >
      <ThreadCodeDisplay
        header={<ThreadCommandHeader command={command} surface="framed" />}
        output={output ?? undefined}
        preview
        previewHeight={previewHeight}
        variant="plain"
      />
    </ThreadDisclosure>
  );
}

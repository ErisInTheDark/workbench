/*
 * Exports:
 * - default ThreadCommandDetails: reveal the captured command and output inside a nested thread disclosure. Keywords: thread, command, output, disclosure.
 */
"use client";

import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import ThreadDisclosure from "./ThreadDisclosure";

export default function ThreadCommandDetails ({
  command,
  output,
}: {
  command: string;
  output?: string | null;
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
        previewHeight="16rem"
        variant="plain"
      />
    </ThreadDisclosure>
  );
}

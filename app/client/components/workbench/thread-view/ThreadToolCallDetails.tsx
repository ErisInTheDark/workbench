/*
 * Exports:
 * - default ThreadToolCallDetails: render a tool invocation and captured output through the ordinary shell-command code surface. Keywords: tool call, input, output, disclosure.
 * - ThreadHydratedToolCallDetails: the same surface for a tool item whose output may hydrate on open, with loading and retry states.
 */
"use client";

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import ThreadCodeDisplay, { ThreadCommandHeader } from "./ThreadCodeDisplay";
import { useTranscript } from "../use-transcript";

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

/** Mount only where the output shows (an opened disclosure): mounting is what loads a deferred body. */
export function ThreadHydratedToolCallDetails<Item extends ThreadItem>({
  invocation,
  item,
  output,
}: {
  invocation: string;
  item: Item;
  output: (item: Item) => string | null;
}) {
  const body = useTranscript.item(item);
  return (
    <>
      <ThreadToolCallDetails
        invocation={invocation}
        output={body.status === "ready" ? output(body.item) : body.status === "loading" ? "Loading output…" : null}
      />
      {body.status === "failed" || body.status === "unavailable" ? (
        <p role="alert" className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-danger">
          {body.status === "failed" ? `Output failed to load: ${body.failure}` : "Output is not available in this view."}
          {body.status === "failed" ? (
            <button type="button" className="underline underline-offset-2" onClick={body.retry}>Retry</button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

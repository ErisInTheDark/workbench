/*
 * Exports:
 * - default ThreadDeferredBodyAlert: the failed or unavailable state of a deferred item body (`useTranscript.item`), with retry.
 */
"use client";

import type { useTranscript } from "../use-transcript";

type DeferredBody = ReturnType<typeof useTranscript.item>;

export default function ThreadDeferredBodyAlert({ body, noun }: { body: DeferredBody; noun: string }) {
  if (body.status !== "failed" && body.status !== "unavailable") return null;
  return (
    <p role="alert" className="m-0 flex flex-wrap items-baseline gap-2 text-[0.78em] leading-[1.6] text-danger">
      {body.status === "failed" ? `${noun} failed to load: ${body.failure}` : `${noun} is not available in this view.`}
      {body.status === "failed" ? (
        <button type="button" className="underline underline-offset-2" onClick={body.retry}>Retry</button>
      ) : null}
    </p>
  );
}

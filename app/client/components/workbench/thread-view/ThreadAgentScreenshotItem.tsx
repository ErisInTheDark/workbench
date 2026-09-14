/*
 * Keywords: screenshot, native injection, legacy steer, presentation.
 * Exports:
 * - default ThreadAgentScreenshotItem: shared captured-image surface without user-message authority.
 */
"use client";

import type { ReactNode } from "react";
import ThreadUserImage from "./ThreadUserImage";

export default function ThreadAgentScreenshotItem({
  images,
  timestamp,
}: {
  images: readonly string[];
  timestamp?: ReactNode;
}) {
  if (!images.length) return null;
  return (
    <section className="flex flex-col items-start py-2" data-thread-user-message-state="agent-screenshot-steer">
      <div className="w-full max-w-[42rem] space-y-2">
        {images.map((url, index) => (
          <ThreadUserImage key={index} alt="Agent-captured screenshot" className="max-w-[28rem]" src={url} />
        ))}
      </div>
      {timestamp}
    </section>
  );
}

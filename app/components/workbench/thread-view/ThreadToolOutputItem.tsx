/*
 * Keywords: native tool output, incoming agent, screenshot, patch recovery.
 * Exports:
 * - default ThreadToolOutputItem: render supported output bodies with their existing semantic surfaces.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import { readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import type { WorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { getSubagentSummary } from "../../../workbench/thread/thread-subagents";
import ThreadAgentScreenshotItem from "./ThreadAgentScreenshotItem";
import ThreadIncomingAgentMessageItem from "./ThreadIncomingAgentMessageItem";
import ThreadMarkdown from "./ThreadMarkdown";
import ThreadUserImage from "./ThreadUserImage";

export default function ThreadToolOutputItem({
  item,
  subagents,
  timestamp,
  ...markdownProps
}: Omit<ComponentProps<typeof ThreadMarkdown>, "markdown"> & {
  item: WorkbenchToolOutput;
  subagents: readonly WorkbenchSubagentSummary[];
  timestamp?: ReactNode;
}) {
  if (item.namespace === "workbench" && item.name === "patch_recovery") return null;
  const message = readWorkbenchAgentMessageItem(item);
  if (message) {
    return <ThreadIncomingAgentMessageItem {...markdownProps} message={message} subagent={getSubagentSummary(subagents, message.senderThreadId)} timestamp={timestamp} />;
  }
  if (item.namespace === "workbench" && item.name === "screenshot" && Array.isArray(item.output)) {
    const images = item.output.flatMap((part) => part.type === "input_image" ? [part.image_url] : []);
    if (images.length) return <ThreadAgentScreenshotItem images={images} timestamp={timestamp} />;
  }
  const parts = typeof item.output === "string" ? [{ type: "input_text" as const, text: item.output }] : item.output;
  return (
    <section className="space-y-2 py-2">
      <p className="m-0 text-[0.78em] text-muted">{[item.namespace, item.name].filter(Boolean).join(".")}</p>
      {parts.map((part, index) => part.type === "input_text"
        ? <ThreadMarkdown {...markdownProps} key={index} markdown={part.text} />
        : <ThreadUserImage key={index} alt="Tool output image" src={part.image_url} />)}
      {timestamp}
    </section>
  );
}

"use client";

import type { ReactNode } from "react";

import { getThreadAgentAccentColor, getThreadAgentLabelParts } from "../../../lib/workbench/thread/thread-collab-agents";

export default function ThreadAgentName ({
  className = "",
  fallbackKey = "",
  roleClassName = "text-muted",
  thread,
}: {
  className?: string;
  fallbackKey?: string;
  roleClassName?: string;
  thread: {
    agentNickname?: string | null;
    agentRole?: string | null;
  } | null | undefined;
}): ReactNode {
  const label = getThreadAgentLabelParts(thread);
  if (!label.nickname || !label.role || label.nickname.localeCompare(label.role, undefined, { sensitivity: "accent" }) === 0) {
    return (
      <span className={className}>
        {label.text}
      </span>
    );
  }

  return (
    <span className={className}>
      <span style={{ color: getThreadAgentAccentColor(thread, fallbackKey) }}>{label.nickname}</span>
      <span className={roleClassName}> ({label.role})</span>
    </span>
  );
}

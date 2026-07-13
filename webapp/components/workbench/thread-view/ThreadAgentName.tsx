"use client";

import type { ReactNode } from "react";
import type { WorkbenchSubagentSummary } from "../../../lib/types";

import { getThreadAgentAccentColor, getThreadAgentLabelParts } from "../../../lib/workbench/thread/thread-subagents";

export default function ThreadAgentName ({
  className = "",
  fallbackKey = "",
  roleClassName = "text-muted",
  subagent,
  thread,
}: {
  className?: string;
  fallbackKey?: string;
  roleClassName?: string;
  subagent?: WorkbenchSubagentSummary | null;
  thread: {
    agentNickname?: string | null;
    agentRole?: string | null;
  } | null | undefined;
}): ReactNode {
  const label = getThreadAgentLabelParts(thread, subagent);
  if (!label.nickname) {
    return (
      <span className={className}>
        {label.text}
      </span>
    );
  }
  const hasDistinctRole = Boolean(
    label.role
    && label.nickname.localeCompare(label.role, undefined, { sensitivity: "accent" }) !== 0,
  );

  return (
    <span className={className}>
      <span style={{ color: getThreadAgentAccentColor(thread, fallbackKey, subagent) }}>{label.nickname}</span>
      {hasDistinctRole ? <span className={roleClassName}> ({label.role})</span> : null}
    </span>
  );
}

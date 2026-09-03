"use client";

import type { ReactNode } from "react";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import { getThreadAgentAccentColor, getThreadAgentLabelParts } from "../../../workbench/thread/thread-subagents";

export default function ThreadAgentName ({
  accentChromaPercent,
  className = "",
  roleClassName = "text-muted",
  subagent,
  thread,
}: {
  accentChromaPercent?: number;
  className?: string;
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
      <span className="font-medium" style={subagent ? { color: getThreadAgentAccentColor(subagent, accentChromaPercent) } : undefined}>{label.nickname}</span>
      {hasDistinctRole ? <span className={roleClassName}> ({label.role})</span> : null}
    </span>
  );
}

/*
 * Keywords: thread, subagent, nickname, role, hue.
 * Exports:
 * - default ThreadAgentName: render identity-coloured nicknames with distinct role labels.
 */
"use client";

import type { ReactNode } from "react";
import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import { getThreadAgentAccentHue, getThreadAgentLabelParts } from "../../../workbench/thread/thread-subagents";
import type { IdentityAccentStyle } from "../../../workbench/identity-accent-color";

export default function ThreadAgentName ({
  accentChromaPercent,
  className = "",
  roleClassName = "text-fg/muted",
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
  const accentStyle: IdentityAccentStyle | undefined = subagent ? {
    "--identity-hue": getThreadAgentAccentHue(subagent),
    "--hue-chroma": `${accentChromaPercent ?? 90}%`,
  } : undefined;

  return (
    <span className={className}>
      <span
        className={`font-medium ${subagent ? "text-hue-(--identity-hue)" : ""}`}
        style={accentStyle}
      >{label.nickname}</span>
      {hasDistinctRole ? <span className={roleClassName}> ({label.role})</span> : null}
    </span>
  );
}

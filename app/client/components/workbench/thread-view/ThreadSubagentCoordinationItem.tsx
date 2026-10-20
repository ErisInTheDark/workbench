/*
 * Exports:
 * - default ThreadSubagentCoordinationItem: one subagent coordination exchange as a step line naming its participants,
 *   opening onto the exchange.
 */
"use client";

import type { ReactNode } from "react";

import { BotIcon } from "../workbench-icons";
import { ThreadInlineList } from "./ThreadAgentNameList";
import ThreadStepRow from "./ThreadStepRow";
import { stepLabel, stepLabels } from "./thread-step";

const LABELS = stepLabels("Coordinating with", "Coordinated with", "Failed coordinating with");

export default function ThreadSubagentCoordinationItem({
  active = false,
  activeStartedAtMs = null,
  children,
  durationMs = null,
  participants,
}: {
  active?: boolean;
  activeStartedAtMs?: number | null;
  children?: ReactNode;
  durationMs?: number | null;
  participants: Array<{ key: string; label: ReactNode }>;
}) {
  const state = active ? "inProgress" : "completed";
  return (
    <ThreadStepRow
      bodyInset={false}
      icon={<BotIcon size={16} />}
      keepMounted
      label={stepLabel(LABELS, state)}
      progress={{ durationMs, startedAtMs: activeStartedAtMs, state }}
      subject={participants.length ? <ThreadInlineList items={participants} /> : "subagents"}
    >
      {children}
    </ThreadStepRow>
  );
}

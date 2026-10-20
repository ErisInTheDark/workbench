/*
 * Exports:
 * - default ThreadSubagentCreateItem: subagent creation as a step line opening onto its instructions or, inside a
 *   coordination exchange, a first message to the new subagent.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchComposerProfileContext from "../WorkbenchComposerProfileContext";
import ThreadAgentName from "./ThreadAgentName";
import { BotIcon } from "../workbench-icons";
import { ThreadAgentMessageBubble } from "./ThreadAgentMessageItem";
import ThreadStepRow from "./ThreadStepRow";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";
import { stepLabel, stepLabels } from "./thread-step";

const LABELS = stepLabels("Creating", "Created", "Failed to create");

export default function ThreadSubagentCreateItem ({
  active,
  children,
  fallbackName,
  fallbackTitle,
  profileId,
  subagent,
  unwrapped = false,
}: {
  active: boolean;
  children: ReactNode;
  fallbackName: string;
  fallbackTitle: string;
  profileId: string;
  subagent?: WorkbenchSubagentSummary | null;
  unwrapped?: boolean;
}) {
  const composerProfileContext = useContext(WorkbenchComposerProfileContext);
  const name = subagent?.name ?? fallbackName;
  const profileName = subagent?.profileName
    ?? composerProfileContext?.snapshot.profiles.find((profile) => profile.id === profileId)?.name
    ?? null;
  const title = subagent?.title ?? fallbackTitle;
  const state = active ? "inProgress" : "completed";
  const label = stepLabel(LABELS, state);

  // Inside a coordination exchange a creation is the first message to that subagent, so it reads like the others.
  if (unwrapped) {
    return (
      <ThreadAgentMessageBubble
        recipient={(
          <>
            <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} />
            {profileName || title ? <span className="font-normal">{[profileName, title].filter(Boolean).join(" — ")}</span> : null}
          </>
        )}
        verb={label}
      >
        {children}
      </ThreadAgentMessageBubble>
    );
  }

  return (
    <ThreadStepRow
      defaultOpen={active}
      icon={<BotIcon size={16} />}
      label={label}
      progress={{ state }}
      subject={(
        <span className="min-w-0 truncate">
          <ThreadAgentName subagent={subagent} thread={{ agentNickname: name, agentRole: null }} />
          {profileName ? <span> ({profileName})</span> : null}
          {title ? <span> — {title}</span> : null}
        </span>
      )}
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </ThreadStepRow>
  );
}

/*
 * Exports:
 * - default ThreadSubagentCreateItem: render subagent creation as a standalone disclosure or, inside a coordination
 *   exchange, a first message to the new subagent.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchComposerProfileContext from "../WorkbenchComposerProfileContext";
import ThreadAgentName from "./ThreadAgentName";
import Disclosure from "../../ui/Disclosure";
import { BotIcon } from "../workbench-icons";
import { ThreadAgentMessageBubble } from "./ThreadAgentMessageItem";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

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
  const summary = (
    <span>
      {active ? "Creating " : "Created "}
      <ThreadAgentName
        subagent={subagent}
        thread={{ agentNickname: name, agentRole: null }}
      />
      {profileName ? <span> ({profileName})</span> : null}
      {title ? <span> — {title}</span> : null}
    </span>
  );

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
        verb={active ? "Creating" : "Created"}
      >
        {children}
      </ThreadAgentMessageBubble>
    );
  }

  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      hideChevron
      leading={<BotIcon size={16} />}
      summary={summary}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </Disclosure>
  );
}

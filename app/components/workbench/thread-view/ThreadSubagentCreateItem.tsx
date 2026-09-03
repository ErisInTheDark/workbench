/*
 * Exports:
 * - default ThreadSubagentCreateItem: render active or successful subagent creation with durable identity metadata and the initial user prompt. Keywords: workbench, thread, subagent, create, profile, title, prompt.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchComposerProfileContext from "../WorkbenchComposerProfileContext";
import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

export default function ThreadSubagentCreateItem ({
  active,
  children,
  fallbackName,
  fallbackTitle,
  profileId,
  subagent,
}: {
  active: boolean;
  children: ReactNode;
  fallbackName: string;
  fallbackTitle: string;
  profileId: string;
  subagent?: WorkbenchSubagentSummary | null;
}) {
  const composerProfileContext = useContext(WorkbenchComposerProfileContext);
  const name = subagent?.name ?? fallbackName;
  const profileName = subagent?.profileName
    ?? composerProfileContext?.snapshot.profiles.find((profile) => profile.id === profileId)?.name
    ?? null;
  const title = subagent?.title ?? fallbackTitle;

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      summary={(
        <span>
          {active ? "Creating " : "Created "}
          <ThreadAgentName
            subagent={subagent}
            thread={{ agentNickname: name, agentRole: null }}
          />
          {profileName ? <span> ({profileName})</span> : null}
          {title ? <span> — {title}</span> : null}
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </ThreadDisclosure>
  );
}

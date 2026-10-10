/*
 * Exports:
 * - default ThreadSubagentCreateItem: render subagent creation as a standalone disclosure or unwrapped coordination content.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";

import WorkbenchComposerProfileContext from "../WorkbenchComposerProfileContext";
import ThreadAgentName from "./ThreadAgentName";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
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

  if (unwrapped) {
    return (
      <>
        <DisclosureStaticRow
          summary={summary}
          summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
        />
        <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
      </>
    );
  }

  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      summary={summary}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <ThreadSubagentUserMessage>{children}</ThreadSubagentUserMessage>
    </Disclosure>
  );
}

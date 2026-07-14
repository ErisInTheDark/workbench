/*
 * Exports:
 * - default ThreadSubagentCreateItem: render active or successful subagent creation with durable identity metadata and the initial user prompt. Keywords: workbench, thread, subagent, create, profile, title, prompt.
 */
"use client";

import type { ReactNode } from "react";

import type { WorkbenchSubagentSummary } from "../../../lib/types";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadSubagentUserMessage from "./ThreadSubagentUserMessage";

export default function ThreadSubagentCreateItem ({
  active,
  children,
  fallbackName,
  fallbackProfileName,
  fallbackTitle,
  subagent,
  threadId,
}: {
  active: boolean;
  children: ReactNode;
  fallbackName: string;
  fallbackProfileName: string;
  fallbackTitle: string;
  subagent?: WorkbenchSubagentSummary | null;
  threadId?: string | null;
}) {
  const name = subagent?.name ?? fallbackName;
  const profileName = subagent?.profileName ?? fallbackProfileName;
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
            fallbackKey={threadId ?? name}
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

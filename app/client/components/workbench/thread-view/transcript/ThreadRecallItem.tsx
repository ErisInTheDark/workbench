/*
 * Exports:
 * - default ThreadRecallItem: one recalled narrative record (message, agent text or plan) drawn like the transcript item it came from.
 */
"use client";

import type { WorkbenchThreadRecallOutputRecord } from "../../../../workbench/thread/thread-recall-output";
import Disclosure from "../../../ui/Disclosure";
import MarkdownRender from "../../../ui/MarkdownRender";
import ThreadPlanSummary from "../ThreadPlanSummary";
import { ThreadAgentMessageItem } from "./ThreadAgentMessageItems";
import ThreadUserMessageItem from "./ThreadUserMessageItem";

function ThreadRecallPlanItem ({ markdown }: { markdown: string }) {
  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      summary={<ThreadPlanSummary markdown={markdown} />}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      <MarkdownRender markdown={markdown} />
    </Disclosure>
  );
}

export default function ThreadRecallItem({ record }: { record: WorkbenchThreadRecallOutputRecord }) {
  const id = `thread-recall:${record.ref}`;
  switch (record.kind) {
    case "user-message":
    case "user-steer":
      return (
        <ThreadUserMessageItem
          item={{ clientId: null, content: [{ text: record.text, text_elements: [], type: "text" }], id, type: "userMessage" }}
          startedAt={null}
        />
      );
    case "commentary":
    case "final-answer":
    case "agent-message":
      return (
        <ThreadAgentMessageItem
          canonical
          completedAt={null}
          isFinal={record.kind === "final-answer"}
          item={{
            id,
            memoryCitation: null,
            delivery: null,
            questions: null,
            phase: record.kind === "commentary" ? "commentary" : record.kind === "final-answer" ? "final_answer" : null,
            text: record.text,
            type: "agentMessage",
          }}
        />
      );
    case "plan":
      return <ThreadRecallPlanItem markdown={record.text} />;
    case "questionnaire":
      return null;
  }
}

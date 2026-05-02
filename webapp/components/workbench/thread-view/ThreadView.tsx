"use client";

import { memo, useLayoutEffect, useRef } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type {
  ThreadPayload,
  WorkbenchHarness,
  WorkbenchModelOption,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../lib/types";
import ThreadComposer from "./ThreadComposer";
import ThreadRateLimits from "./ThreadRateLimits";
import { ThreadTurnDetails } from "./thread-view-items";

function ThreadView ({
  composerInfoMessage,
  fontSizeRem,
  onClearUserInputRequest,
  onDraftHarnessChange,
  onListModels,
  onOpenFile,
  onSendMessage,
  onShowExampleQuestion,
  onSubmitUserInputRequest,
  onThreadAgentChange,
  onThreadReasoningEffortChange,
  onThreadModelChange,
  pendingUserInputRequest,
  pendingUserInputRequestMode,
  projectRootPath,
  rateLimits,
  thread,
}: {
  composerInfoMessage: string;
  fontSizeRem: number;
  onClearUserInputRequest: (threadId: string) => void;
  onDraftHarnessChange: (harness: WorkbenchHarness) => void;
  onListModels: (harness: WorkbenchHarness) => Promise<WorkbenchModelOption[]>;
  onOpenFile: (path: string) => Promise<void>;
  onSendMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  onShowExampleQuestion: (threadId: string) => void;
  onSubmitUserInputRequest: (threadId: string, response: WorkbenchUserInputResponse) => Promise<void>;
  onThreadAgentChange: (threadId: string, agentPath: string | null) => void;
  onThreadReasoningEffortChange: (threadId: string, effort: string | null) => void;
  onThreadModelChange: (threadId: string, model: string) => void;
  pendingUserInputRequest: WorkbenchUserInputRequest | null;
  pendingUserInputRequestMode: "live" | "preview" | null;
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  thread: ThreadPayload;
}) {
  const isDraftThread = thread.isDraft;
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const currentTurn = thread.turns.at(-1) ?? null;
  const isThinking = currentTurn?.status === "inProgress";

  useLayoutEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      bottomSentinelRef.current?.scrollIntoView({ block: "end" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [thread.id]);

  return (
    <div className="mx-auto w-full max-w-[56rem] pb-16" style={{ fontSize: `${fontSizeRem}rem` }}>
      {isDraftThread ? (
        <header className="pb-4">
          <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">
            Create new thread
          </h2>
        </header>
      ) : null}

      <div>
        {thread.turns.length ? thread.turns.map((turn) => (
          <ThreadTurnDetails
            key={turn.id}
            onOpenFile={onOpenFile}
            projectRootPath={projectRootPath}
            turn={turn}
          />
        )) : (
          !isDraftThread ? (
            <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-muted">
              No turns were returned for this thread yet.
            </p>
          ) : null
        )}
      </div>
      {isThinking ? (
        <div className="py-4" aria-live="polite">
          <p className="thread-thinking-text m-0 text-[0.92em] font-medium leading-[1.6]">
            Thinking
          </p>
        </div>
      ) : null}
      <ThreadComposer
        composerInfoMessage={composerInfoMessage}
        onClearUserInputRequest={onClearUserInputRequest}
        onListModels={onListModels}
        onSendMessage={onSendMessage}
        onShowExampleQuestion={onShowExampleQuestion}
        onSubmitUserInputRequest={onSubmitUserInputRequest}
        onThreadAgentChange={onThreadAgentChange}
        onThreadReasoningEffortChange={onThreadReasoningEffortChange}
        onThreadModelChange={onThreadModelChange}
        pendingUserInputRequest={pendingUserInputRequest}
        pendingUserInputRequestMode={pendingUserInputRequestMode}
        rateLimits={rateLimits}
        thread={thread}
      />
      <ThreadRateLimits
        canToggleHarness={thread.isDraft}
        harness={thread.harness}
        onHarnessToggle={() => {
          onDraftHarnessChange(thread.harness === "codex" ? "copilot" : "codex");
        }}
        rateLimits={rateLimits}
      />
      <div ref={bottomSentinelRef} aria-hidden="true" className="h-px w-full" />
    </div>
  );
}

export default memo(ThreadView);

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
import ThreadDisclosure from "./ThreadDisclosure";
import ThreadRateLimits from "./ThreadRateLimits";
import { ThreadTurnDetails } from "./thread-view-items";
import {
  formatThreadTimestamp,
  getThreadTitle,
} from "./thread-view-primitives";

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
  projectRootPath: string;
  rateLimits: RateLimitSnapshot | null;
  thread: ThreadPayload;
}) {
  const title = getThreadTitle(thread);
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
      <header className="pb-4">
        <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">
          {isDraftThread ? "Create new thread" : title}
        </h2>
        {!isDraftThread && thread.preview && thread.preview !== title ? (
          <p className="mt-2 mb-0 max-w-3xl text-[0.92em] leading-[1.75] text-muted">{thread.preview}</p>
        ) : null}
        {!isDraftThread ? (
          <>
            <p className="mt-2 mb-0 text-[0.78em] leading-[1.6] text-muted">
              Updated {formatThreadTimestamp(thread.updatedAt)} | Created {formatThreadTimestamp(thread.createdAt)}
            </p>
            <ThreadDisclosure
              className="mt-1 text-[0.78em] leading-[1.6] text-muted"
              contentClassName="mt-1 space-y-1 pl-6"
              summary="Thread info"
              summaryClassName="text-muted"
            >
              <>
                <p className="m-0">Status: {thread.status}</p>
                <p className="m-0">Source: {thread.source}</p>
                <p className="m-0 break-all font-mono text-[0.78em]">{thread.cwd}</p>
                {thread.path ? (
                  <p className="m-0 break-all font-mono text-[0.78em]">{thread.path}</p>
                ) : null}
              </>
            </ThreadDisclosure>
          </>
        ) : null}
      </header>

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

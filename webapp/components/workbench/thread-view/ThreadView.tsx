"use client";

import { memo } from "react";

import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import type { ThreadPayload } from "../../../lib/types";
import ThreadComposer from "./ThreadComposer";
import { ThreadTurnDetails } from "./thread-view-items";
import ThreadDisclosure from "./ThreadDisclosure";
import {
  formatThreadTimestamp,
  getThreadTitle,
} from "./thread-view-primitives";

function ThreadView({
  fontSizeRem,
  onOpenFile,
  onSendMessage,
  projectRootPath,
  thread,
}: {
  fontSizeRem: number;
  onOpenFile: (path: string) => Promise<void>;
  onSendMessage: (threadId: string, input: UserInput[]) => Promise<void>;
  projectRootPath: string;
  thread: ThreadPayload;
}) {
  const title = getThreadTitle(thread);

  return (
    <div className="mx-auto w-full max-w-[56rem] pb-16" style={{ fontSize: `${fontSizeRem}rem` }}>
      <header className="pb-4">
        <h2 className="m-0 text-[1.55em] font-semibold leading-[1.1] tracking-tight text-text">{title}</h2>
        {thread.preview && thread.preview !== title ? (
          <p className="mt-2 mb-0 max-w-3xl text-[0.92em] leading-[1.75] text-muted">{thread.preview}</p>
        ) : null}
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
          <p className="m-0 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)] py-4 text-[0.92em] leading-[1.6] text-muted">
            No turns were returned for this thread yet.
          </p>
        )}
      </div>
      <ThreadComposer
        onSendMessage={onSendMessage}
        threadId={thread.id}
        threadStatus={thread.status}
      />
    </div>
  );
}

export default memo(ThreadView);

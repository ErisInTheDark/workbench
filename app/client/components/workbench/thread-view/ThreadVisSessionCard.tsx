/*
 * Exports:
 * - default ThreadVisSessionCard: show each live vis session's latest render above the work lifecycle card, keeping it while
 *   a new render is in flight, with frame-reload and end buttons and the outcome of the latest answer the page sent through
 *   `wb.send`; whether the card is open persists per browser. Presentational:
 *   the thread view observes the sessions, so mockups can render this with any sessions.
 */
"use client";

import { useState } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { WorkbenchClientStateRecord } from "workbench-shared/state/workbench-client-state";
import type { VisLiveSession } from "workbench-shared/workbench/vis/vis-contract";
import LoaderIcon from "../LoaderIcon";
import IconButton from "../../ui/IconButton";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { CheckIcon, RefreshCwIcon, XIcon } from "../workbench-icons";
import Disclosure from "../../ui/Disclosure";
import ThreadVisFrame from "./ThreadVisFrame";

function readOpen(records: readonly WorkbenchClientStateRecord[]) {
  for (const record of records) {
    if (record.kind === "globalPreference" && record.preference.key === "threadVisOpen") return record.preference.value;
  }
  return true;
}

function Spinner({ label }: { label: string }) {
  return <span aria-label={label} className="inline-flex shrink-0" role="status"><LoaderIcon size={14} /></span>;
}

function SessionActions({ onEnd, onReload, session }: {
  onEnd: (sessionId: string) => void;
  onReload: (sessionId: string) => void;
  session: VisLiveSession;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5" data-thread-summary-action="true">
      <IconButton display="hover-border" label={`Reload the frame for ${session.path}`} onClick={() => onReload(session.sessionId)} size="compact">
        <RefreshCwIcon size={14} />
      </IconButton>
      <IconButton display="hover-border" label={`End vis on ${session.path}`} onClick={() => onEnd(session.sessionId)} size="compact">
        <XIcon size={16} />
      </IconButton>
    </span>
  );
}

type AnswerStatus = { kind: "sent"; at: number } | { kind: "failed"; message: string };

function AnswerStatusLine({ status }: { status: AnswerStatus | undefined }) {
  if (!status) return null;
  if (status.kind === "failed") return <p className="m-0 text-[0.74rem] text-danger" role="alert">Answer not sent: {status.message}</p>;
  return (
    <p className="m-0 flex items-center gap-1 text-[0.74rem] text-fg/muted" role="status">
      <CheckIcon size={14} /> Answer sent to the agent <WorkbenchRelativeTime timestampMs={status.at} />
    </p>
  );
}

/** A lone session's path, time and buttons are the card's summary, so only multi-file cards repeat them per row. */
function VisSession({ actions, answerStatus, onAnswer, reloads, session }: {
  actions: Parameters<typeof SessionActions>[0] | null;
  answerStatus: AnswerStatus | undefined;
  onAnswer: (value: string) => void;
  /** Bumping this remounts the frame, rerunning the same document from scratch. */
  reloads: number;
  session: VisLiveSession;
}) {
  return (
    <div className="space-y-1.5 px-3 py-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[color-mix(in_srgb,var(--text)_10%,transparent)]">
      {actions ? (
        <div className="flex min-w-0 items-center gap-2 text-[0.76rem] text-fg/muted">
          <span className="min-w-0 truncate font-mono text-text">{session.path}</span>
          {session.render ? <WorkbenchRelativeTime className="shrink-0" timestampMs={session.render.renderedAt} /> : null}
          {session.rendering ? <Spinner label="Rendering the latest change" /> : null}
          <SessionActions {...actions} />
        </div>
      ) : null}
      {session.failure ? <p className="m-0 whitespace-pre-wrap text-[0.74rem] text-danger" role="alert">{session.failure}</p> : null}
      <AnswerStatusLine status={answerStatus} />
      {session.render ? (
        <ThreadVisFrame
          className="rounded-[0.65rem] bg-fg/4"
          document={session.render.document}
          key={reloads}
          onAnswer={onAnswer}
          title={`Live vis of ${session.path}`}
        />
      ) : (
        <div aria-hidden="true" className="h-48 animate-pulse rounded-[0.65rem] bg-fg/4 motion-reduce:animate-none" />
      )}
    </div>
  );
}

export default function ThreadVisSessionCard({ onAnswer, onEnd, sessions }: {
  /** Forwards one answer from a session's frame; rejects when Workbench did not record it. */
  onAnswer: (sessionId: string, value: string) => Promise<void>;
  onEnd: (sessionId: string) => void;
  sessions: readonly VisLiveSession[];
}) {
  const [reloads, setReloads] = useState<Readonly<Record<string, number>>>({});
  const [answers, setAnswers] = useState<Readonly<Record<string, AnswerStatus>>>({});
  const answer = (sessionId: string) => (value: string) => {
    onAnswer(sessionId, value).then(
      () => setAnswers((current) => ({ ...current, [sessionId]: { kind: "sent", at: Date.now() } })),
      (error: unknown) => setAnswers((current) => ({
        ...current, [sessionId]: { kind: "failed", message: error instanceof Error ? error.message.slice(0, 200) : "Workbench did not record it." },
      })),
    );
  };
  const onReload = (sessionId: string) => setReloads((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
  const clientStateController = useWorkbenchClientStateController();
  const clientState = useWorkbenchClientStateSnapshot();
  const canPersist = clientState.schemaVersion >= appStateReleases.threadVisOpen.version;
  const [unpersistedOpen, setUnpersistedOpen] = useState(true);
  const open = canPersist ? readOpen(clientState.records) : unpersistedOpen;
  if (!sessions.length) return null;
  const setOpen = (next: boolean) => {
    if (next === open) return;
    if (!canPersist) {
      setUnpersistedOpen(next);
      return;
    }
    void clientStateController.put({ kind: "globalPreference", preference: { key: "threadVisOpen", value: next } }).catch((error) => {
      console.error("Workbench vis disclosure persistence failed.", error);
    });
  };
  const lone = sessions.length === 1 ? sessions[0]! : null;
  const rendering = sessions.some((session) => session.rendering);
  const updatedAt = Math.max(0, ...sessions.map(({ render }) => render?.renderedAt ?? 0));
  return (
    <section className="w-full overflow-hidden rounded-[0.9rem] border border-[color-mix(in_srgb,var(--text)_12%,transparent)] bg-fg/2" data-thread-vis-card="true">
      <Disclosure
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
        summary={(
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">Live vis</span>
            <span className="truncate font-semibold text-text">{lone ? lone.path : `${sessions.length} files`}</span>
            {updatedAt ? <WorkbenchRelativeTime className="shrink-0" timestampMs={updatedAt} /> : null}
            {rendering && (lone || !open) ? <Spinner label="Rendering" /> : null}
            {lone ? <SessionActions onEnd={onEnd} onReload={onReload} session={lone} /> : null}
          </span>
        )}
        summaryClassName="px-3 py-1.5 text-[0.8rem]"
      >
        {sessions.map((session) => (
          <VisSession
            actions={lone ? null : { onEnd, onReload, session }}
            answerStatus={answers[session.sessionId]}
            key={session.sessionId}
            onAnswer={answer(session.sessionId)}
            reloads={reloads[session.sessionId] ?? 0}
            session={session}
          />
        ))}
      </Disclosure>
    </section>
  );
}

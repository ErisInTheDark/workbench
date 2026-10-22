/*
 * Exports:
 * - default ThreadVisSessionCard: show each live vis session's latest render under a summary row, keeping it while
 *   a new render is in flight, with theatre, fullscreen, frame-reload and end buttons; control changes its page makes
 *   through `wb.state` are saved, and only a failed save is reported. With several sessions each is an open disclosure
 *   whose summary row carries its buttons, and theatre stays on the card's header. Frameless and presentational: its
 *   host frames it, owns theatre width, and the thread view observes the sessions.
 * - getVisSessionsUpdatedAt: latest render time across sessions.
 */
"use client";

import { useState, type ReactNode } from "react";
import type { VisLiveSession } from "workbench-shared/workbench/vis/vis-contract";
import LoaderIcon from "../LoaderIcon";
import Disclosure from "../../ui/Disclosure";
import IconButton from "../../ui/IconButton";
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";
import { FoldHorizontalIcon, MaximizeIcon, RefreshCwIcon, UnfoldHorizontalIcon, XIcon } from "../workbench-icons";
import ThreadVisFrame from "./ThreadVisFrame";

function Spinner({ label }: { label: string }) {
  return <span aria-label={label} className="inline-flex shrink-0" role="status"><LoaderIcon size={14} /></span>;
}

function TheatreToggle({ onChange, theatre }: { onChange: (theatre: boolean) => void; theatre: boolean }) {
  return (
    <IconButton
      aria-pressed={theatre}
      display="hover-border"
      label={theatre ? "Exit theatre mode" : "Theatre mode"}
      onClick={() => onChange(!theatre)}
      size="compact"
    >
      {theatre ? <FoldHorizontalIcon size={14} /> : <UnfoldHorizontalIcon size={14} />}
    </IconButton>
  );
}

type SessionActionsProps = {
  onEnd: (sessionId: string) => void;
  onFullscreen: (sessionId: string) => void;
  onReload: (sessionId: string) => void;
  session: VisLiveSession;
};

function SessionActions({ leading, onEnd, onFullscreen, onReload, session }: SessionActionsProps & { leading?: ReactNode }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5" data-thread-summary-action="true">
      {leading}
      <IconButton display="hover-border" label={`Fullscreen vis of ${session.path}`} onClick={() => onFullscreen(session.sessionId)} size="compact">
        <MaximizeIcon size={14} />
      </IconButton>
      <IconButton display="hover-border" label={`Reload the frame for ${session.path}`} onClick={() => onReload(session.sessionId)} size="compact">
        <RefreshCwIcon size={14} />
      </IconButton>
      <IconButton display="hover-border" label={`End vis on ${session.path}`} onClick={() => onEnd(session.sessionId)} size="compact">
        <XIcon size={16} />
      </IconButton>
    </span>
  );
}

type VisSessionProps = {
  /** Why the latest control change was not saved; saved changes need no word, the page already shows them. */
  controlFailure: string | undefined;
  fullscreen: boolean;
  onControl: (id: string, value: string) => void;
  onExitFullscreen: () => void;
  /** Bumping this remounts the frame, rerunning the same document from scratch. */
  reloads: number;
  session: VisLiveSession;
};

function VisSessionBody({ controlFailure, fullscreen, onControl, onExitFullscreen, reloads, session }: VisSessionProps) {
  return (
    <>
      {session.failure ? <p className="m-0 whitespace-pre-wrap text-[0.74rem] text-danger" role="alert">{session.failure}</p> : null}
      {controlFailure ? <p className="m-0 text-[0.74rem] text-danger" role="alert">Your choice was not saved: {controlFailure}</p> : null}
      {session.render ? (
        <ThreadVisFrame
          className="rounded-[0.65rem] bg-fg/4"
          controls={session.controls}
          document={session.render.document}
          fullscreen={fullscreen}
          key={reloads}
          onControl={onControl}
          onExitFullscreen={onExitFullscreen}
          title={`Live vis of ${session.path}`}
        />
      ) : (
        <div aria-hidden="true" className="h-48 animate-pulse rounded-[0.65rem] bg-fg/4 motion-reduce:animate-none" />
      )}
    </>
  );
}

/** One of several sessions: an open disclosure whose summary row carries its path, time and buttons. */
function CollapsibleVisSession({ actions, ...props }: VisSessionProps & { actions: SessionActionsProps }) {
  const { session } = props;
  return (
    <Disclosure
      className="px-3 py-2 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[color-mix(in_srgb,var(--text)_10%,transparent)]"
      contentClassName="mt-1.5 space-y-1.5"
      defaultOpen
      summary={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-text">{session.path}</span>
          {session.render ? <WorkbenchRelativeTime className="shrink-0" timestampMs={session.render.renderedAt} /> : null}
          {session.rendering ? <Spinner label="Rendering the latest change" /> : null}
          <SessionActions {...actions} />
        </span>
      }
      summaryClassName="text-[0.76rem]"
    >
      <VisSessionBody {...props} />
    </Disclosure>
  );
}

export default function ThreadVisSessionCard({ onControl, onEnd, onTheatreChange, sessions, theatre }: {
  /** Forwards one control change from a session's frame; rejects when Workbench did not save it. */
  onControl: (sessionId: string, id: string, value: string) => Promise<void>;
  onEnd: (sessionId: string) => void;
  onTheatreChange: (theatre: boolean) => void;
  sessions: readonly VisLiveSession[];
  /** The host stretches the card to the whole thread view. */
  theatre: boolean;
}) {
  const [reloads, setReloads] = useState<Readonly<Record<string, number>>>({});
  const [failures, setFailures] = useState<Readonly<Record<string, string | undefined>>>({});
  const [fullscreenSessionId, setFullscreenSessionId] = useState<string | null>(null);
  const control = (sessionId: string) => (id: string, value: string) => {
    onControl(sessionId, id, value).then(
      () => setFailures((current) => current[sessionId] === undefined ? current : { ...current, [sessionId]: undefined }),
      (error: unknown) => setFailures((current) => ({
        ...current, [sessionId]: error instanceof Error ? error.message.slice(0, 200) : "Workbench did not save it.",
      })),
    );
  };
  const onReload = (sessionId: string) => setReloads((current) => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
  if (!sessions.length) return null;
  const lone = sessions.length === 1 ? sessions[0]! : null;
  const rendering = sessions.some((session) => session.rendering);
  const updatedAt = getVisSessionsUpdatedAt(sessions);
  const theatreToggle = <TheatreToggle onChange={onTheatreChange} theatre={theatre} />;
  const actions = (session: VisLiveSession): SessionActionsProps => ({ onEnd, onFullscreen: setFullscreenSessionId, onReload, session });
  const body = (session: VisLiveSession) => ({
    controlFailure: failures[session.sessionId],
    fullscreen: fullscreenSessionId === session.sessionId,
    onControl: control(session.sessionId),
    onExitFullscreen: () => setFullscreenSessionId(null),
    reloads: reloads[session.sessionId] ?? 0,
    session,
  });
  return (
    <section className="w-full" data-thread-vis-card="true">
      <div className="flex min-w-0 items-center gap-1.5 px-3 py-1.5 text-[0.8rem] text-fg/muted">
        <span className="shrink-0">Live vis</span>
        <span className="truncate font-semibold text-text">{lone ? lone.path : `${sessions.length} files`}</span>
        {updatedAt ? <WorkbenchRelativeTime className="shrink-0" timestampMs={updatedAt} /> : null}
        {rendering && lone ? <Spinner label="Rendering" /> : null}
        {lone
          ? <SessionActions {...actions(lone)} leading={theatreToggle} />
          : <span className="ml-auto flex shrink-0 items-center">{theatreToggle}</span>}
      </div>
      {lone ? (
        <div className="space-y-1.5 px-3 py-2">
          <VisSessionBody {...body(lone)} />
        </div>
      ) : (
        <div>
          {sessions.map((session) => <CollapsibleVisSession actions={actions(session)} key={session.sessionId} {...body(session)} />)}
        </div>
      )}
    </section>
  );
}

/** Latest render across the sessions, or 0 before any rendered. */
export function getVisSessionsUpdatedAt(sessions: readonly VisLiveSession[]) {
  return Math.max(0, ...sessions.map(({ render }) => render?.renderedAt ?? 0));
}

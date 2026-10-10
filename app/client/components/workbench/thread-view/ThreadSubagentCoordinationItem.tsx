/*
 * Exports:
 * - default ThreadSubagentCoordinationItem: render one qualifying subagent coordination disclosure.
 */
"use client";

import { Fragment, type ReactNode } from "react";

import Disclosure from "../../ui/Disclosure";
import ThreadDurationText from "./ThreadDurationText";
import { useThreadLiveDuration } from "./use-thread-live-duration";

export default function ThreadSubagentCoordinationItem({
  active = false,
  activeStartedAtMs,
  children,
  durationMs,
  participants,
}: {
  active?: boolean;
  activeStartedAtMs?: number | null;
  children?: ReactNode;
  durationMs?: number | null;
  participants: Array<{ key: string; label: ReactNode }>;
}) {
  const visibleDurationMs = useThreadLiveDuration(durationMs, activeStartedAtMs);
  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-1"
      keepMounted
      summary={(
        <span>
          {active ? "Coordinating with " : "Coordinated with "}
          {participants.length ? participants.map((participant, index) => (
            <Fragment key={participant.key}>
              {index === 0
                ? null
                : index === participants.length - 1
                  ? participants.length === 2 ? " and " : ", and "
                  : ", "}
              {participant.label}
            </Fragment>
          )) : "subagents"}
          {visibleDurationMs !== null && visibleDurationMs !== undefined ? (
            <span className="ml-2 text-[0.84em] text-fg/muted">
              <ThreadDurationText durationMs={visibleDurationMs} />
            </span>
          ) : null}
        </span>
      )}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      {children}
    </Disclosure>
  );
}

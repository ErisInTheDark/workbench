/*
 * Exports:
 * - default ThreadSkillPills: render a thread's active skills as pills whose hover, focus, or touch reveals a deactivate button, with optional row separators.
 */
"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { WorkbenchThreadSkillControls } from "workbench-shared/types";
import { XIcon } from "../workbench-icons";

function RowSeparator () {
  return <span className="text-[0.84em] text-fg/muted" aria-hidden="true">|</span>;
}

export default function ThreadSkillPills ({
  controls,
  separatorAfter = false,
  separatorBefore = false,
  threadId,
}: {
  controls: WorkbenchThreadSkillControls;
  /** Row separators render only while pills do, so an empty skill list leaves no stray divider. */
  separatorAfter?: boolean;
  separatorBefore?: boolean;
  threadId: string;
}) {
  const subscribe = useCallback((listener: () => void) => controls.subscribe(threadId, listener), [controls, threadId]);
  const getSnapshot = useCallback(() => controls.getSnapshot(threadId), [controls, threadId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void controls.load(threadId);
  }, [controls, threadId]);

  if (!snapshot.skills.length && !snapshot.error) return null;

  return (
    <>
      {separatorBefore ? <RowSeparator /> : null}
      <ul aria-label="Active skills" className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
        {snapshot.skills.map((skill) => {
          const pending = snapshot.pendingPaths.includes(skill.path);
          return (
            <li
              key={skill.path}
              className={`group/skill relative ${pending ? "opacity-50" : ""}`}
              title={`/${skill.name}, activated by ${skill.source === "agent" ? "the agent" : "you"}`}
            >
              <span className="inline-flex h-7 items-center rounded-full bg-[color-mix(in_srgb,var(--text)_6%,transparent)] px-2.5 text-[0.76em] font-medium text-fg/muted">
                <span
                  className={`
                    max-w-40 truncate
                    group-hover/skill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                    group-focus-within/skill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                    coarse-touch:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                  `}
                >
                  {skill.name}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Deactivate the ${skill.name} skill`}
                className={`
                  absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-full text-fg/muted opacity-0 transition
                  hover:bg-[color-mix(in_srgb,var(--text)_10%,transparent)] hover:text-text
                  group-hover/skill:opacity-100 focus-visible:opacity-100 coarse-touch:opacity-100
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                  disabled:cursor-not-allowed motion-reduce:transition-none
                `}
                disabled={pending}
                onClick={() => { void controls.deactivate(threadId, skill.path); }}
              >
                <XIcon size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      {snapshot.error ? <span className="ml-1 text-[0.72em] text-danger" role="alert">{snapshot.error}</span> : null}
      {separatorAfter ? <RowSeparator /> : null}
    </>
  );
}

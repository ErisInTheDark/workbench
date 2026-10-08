/*
 * Exports:
 * - default ThreadSkillPills: render a thread's active skills as pills whose hover, focus, or touch reveals a deactivate button, with optional row separators.
 */
"use client";

import { useState } from "react";

import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { getInlineMentionMarkClassName } from "../../../workbench/thread/inline-mention-styles";
import { XIcon } from "../workbench-icons";

function RowSeparator () {
  return <span className="text-[0.84em] text-fg/muted" aria-hidden="true">|</span>;
}

export default function ThreadSkillPills ({
  skills,
  onDeactivate,
  separatorAfter = false,
  separatorBefore = false,
}: {
  skills: readonly WorkbenchThreadSkill[];
  onDeactivate: (path: string) => Promise<void>;
  /** Row separators render only while pills do, so an empty skill list leaves no stray divider. */
  separatorAfter?: boolean;
  separatorBefore?: boolean;
}) {
  const [pendingPaths, setPendingPaths] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (!skills.length && !error) return null;

  // The thread observation drops a deactivated skill; until then its pill stays dimmed.
  const deactivate = async (path: string) => {
    setError(null);
    setPendingPaths(current => [...current, path]);
    try {
      await onDeactivate(path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to update the thread skills.");
    } finally {
      setPendingPaths(current => current.filter(candidate => candidate !== path));
    }
  };

  return (
    <>
      {separatorBefore ? <RowSeparator /> : null}
      <ul aria-label="Active skills" className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
        {skills.map((skill) => {
          const pending = pendingPaths.includes(skill.path);
          return (
            <li
              key={skill.path}
              className={`group/skill relative ${pending ? "opacity-50" : ""}`}
              title={`/${skill.name}, activated by ${skill.source === "agent" ? "the agent" : "you"}`}
            >
              <span className={`
                ${getInlineMentionMarkClassName("skill")}
                inline-flex h-7 items-center rounded-full px-2.5 text-[0.76em] font-medium text-text
              `}>
                <span
                  className={`
                    max-w-40 truncate
                    group-hover/skill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                    group-focus-within/skill:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                    coarse-touch:[mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]
                  `}
                >
                  /{skill.name}
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
                onClick={() => { void deactivate(skill.path); }}
              >
                <XIcon size={12} />
              </button>
            </li>
          );
        })}
      </ul>
      {error ? <span className="ml-1 text-[0.72em] text-danger" role="alert">{error}</span> : null}
      {separatorAfter ? <RowSeparator /> : null}
    </>
  );
}

/*
 * Exports:
 * - default ThreadSkillPills: render a thread's active skills as pills whose hover, focus, or touch reveals a deactivate button, with optional row separators.
 */
"use client";

import { useState } from "react";

import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { getInlineMentionMarkClassName } from "../../../workbench/thread/inline-mention-styles";
import WorkbenchPill from "../WorkbenchPill";

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
        {skills.map((skill) => (
          <li key={skill.path} className="flex">
            <WorkbenchPill
              className={`${getInlineMentionMarkClassName("skill")} text-text`}
              onRemove={() => { void deactivate(skill.path); }}
              pending={pendingPaths.includes(skill.path)}
              removeLabel={`Deactivate the ${skill.name} skill`}
              title={`/${skill.name}, activated by ${skill.source === "agent" ? "the agent" : "you"}`}
            >
              /{skill.name}
            </WorkbenchPill>
          </li>
        ))}
      </ul>
      {error ? <span className="ml-1 text-[0.72em] text-danger" role="alert">{error}</span> : null}
      {separatorAfter ? <RowSeparator /> : null}
    </>
  );
}

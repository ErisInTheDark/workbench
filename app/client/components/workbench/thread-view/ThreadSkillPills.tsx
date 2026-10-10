/*
 * Exports:
 * - default ThreadSkillPills: render a thread's active skills as removable pills, either a row of up to four with the rest behind a skill-toned ellipsis pill's tooltip, or every pill for a panel.
 * - skillPillToneClassName: the skill mention tone shared by skill pills and controls standing for them.
 */
"use client";

import { useState } from "react";

import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { getInlineMentionMarkClassName } from "../../../workbench/thread/inline-mention-styles";
import WorkbenchPill from "../WorkbenchPill";
import Tooltip from "../../ui/Tooltip";
import { EllipsisIcon } from "../workbench-icons";

const VISIBLE_SKILLS = 4;
/** Skill pills and the controls that stand for them share the inline skill mention tone. */
export const skillPillToneClassName = `${getInlineMentionMarkClassName("skill")} text-text`;

export default function ThreadSkillPills ({
  layout = "row",
  skills,
  onDeactivate,
}: {
  /** `row` shows up to four pills then a skill-toned overflow pill; `panel` wraps every pill. */
  layout?: "row" | "panel";
  skills: readonly WorkbenchThreadSkill[];
  onDeactivate: (path: string) => Promise<void>;
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
  const list = (shown: readonly WorkbenchThreadSkill[], label: string) => (
    <ul aria-label={label} className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
      {shown.map((skill) => (
        <li key={skill.path} className="flex">
          <WorkbenchPill
            className={skillPillToneClassName}
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
  );
  const errorNote = error ? <span className="ml-1 text-[0.72em] text-danger" role="alert">{error}</span> : null;
  if (layout === "panel") {
    return <div className="px-3 py-2">{list(skills, "Active skills")}{errorNote}</div>;
  }
  const hidden = skills.slice(VISIBLE_SKILLS);

  return (
    <span className="flex min-w-0 items-center gap-1">
      {list(skills.slice(0, VISIBLE_SKILLS), "Active skills")}
      {hidden.length ? (
        <Tooltip content={<div className="max-w-[min(24rem,80vw)]">{list(hidden, "More active skills")}</div>} interactive placement="top">
          <button
            aria-label={`${hidden.length} more active skills`}
            className={`
              inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[0.76em] font-medium
              ${skillPillToneClassName} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
            `}
            type="button"
          >
            <EllipsisIcon size={14} />
            <span className="tabular-nums">{hidden.length}</span>
          </button>
        </Tooltip>
      ) : null}
      {errorNote}
    </span>
  );
}

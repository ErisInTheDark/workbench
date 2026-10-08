/*
 * Exports:
 * - default ThreadGoalControl: render the Workbench goal flag, objective card, compact editor, and clear confirmation around an active-skill and agent-tab row.
 */
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { WORKBENCH_THREAD_GOAL_MAX_LENGTH, type WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import { FlagIcon } from "../workbench-icons";
import PlaintextEditable from "./PlaintextEditable";
import ThreadSkillPills from "./ThreadSkillPills";

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

const quietButtonClassName = "rounded-lg px-2.5 py-1.5 text-[0.76em] font-medium text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50";

export default function ThreadGoalControl ({
  children,
  goal,
  skills,
  threadId,
  onSetGoal,
  onClearGoal,
  onDeactivateSkill,
}: {
  children?: ReactNode;
  goal: WorkbenchThreadGoal | null;
  /** Active skill pills sit between the goal flag and the agent tabs; null hides them (drafts). */
  skills: readonly WorkbenchThreadSkill[] | null;
  threadId: string;
  onSetGoal: (objective: string) => Promise<void>;
  onClearGoal: () => Promise<void>;
  onDeactivateSkill: (path: string) => Promise<void>;
}) {
  const panelId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [pendingAction, setPendingAction] = useState<"clear" | "update" | null>(null);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");
  const isPending = pendingAction !== null;
  const objective = draft.trim();
  const objectiveIsValid = objective.length > 0 && draft.length <= WORKBENCH_THREAD_GOAL_MAX_LENGTH;

  useEffect(() => {
    setIsOpen(false);
    setIsEditing(false);
    setIsConfirmingClear(false);
    setLocalError("");
    setDraft("");
  }, [threadId]);

  useEffect(() => {
    if (!goal) {
      setIsOpen(false);
      setIsEditing(false);
      setIsConfirmingClear(false);
      setLocalError("");
      setDraft("");
      return;
    }
    if (!isEditing) setDraft(goal.objective);
  }, [goal?.objective, isEditing, threadId]);

  const skillPills = skills
    ? (separators: { before: boolean; after: boolean }) => (
      <ThreadSkillPills skills={skills} onDeactivate={onDeactivateSkill} separatorAfter={separators.after} separatorBefore={separators.before} />
    )
    : () => null;

  if (!goal) {
    if (!children && !skills?.length) return null;
    // Pills render nothing for a thread without active skills; the row then collapses with its margin.
    return (
      <div className="mt-6 has-[>div:empty]:hidden">
        <div className="flex flex-wrap items-center gap-2">
          {skillPills({ before: false, after: Boolean(children) })}
          {children}
        </div>
      </div>
    );
  }

  const run = async (action: "clear" | "update", operation: () => Promise<void>, fallback: string) => {
    setLocalError("");
    setPendingAction(action);
    try {
      await operation();
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : fallback);
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  const save = async () => {
    if (!objectiveIsValid) {
      setLocalError(objective ? `Goal objectives cannot exceed ${WORKBENCH_THREAD_GOAL_MAX_LENGTH.toLocaleString()} characters.` : "Goal objectives cannot be empty.");
      return;
    }
    if (await run("update", () => onSetGoal(objective), "Unable to update the thread goal.")) setIsEditing(false);
  };

  const clear = async () => {
    if (await run("clear", onClearGoal, "Unable to clear the thread goal.")) {
      setIsConfirmingClear(false);
      setIsEditing(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-controls={panelId}
          aria-expanded={isOpen}
          aria-pressed={isOpen}
          aria-label={isOpen ? "Hide thread goal" : "Show thread goal"}
          className="inline-flex size-8 items-center justify-center rounded-full text-text transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          title={isOpen ? "Hide thread goal" : "Show thread goal"}
          onClick={() => setIsOpen((current) => !current)}
        >
          <FlagIcon size={16} />
        </button>
        {skillPills({ before: true, after: false })}
        {children ? <span className="text-[0.84em] text-fg/muted" aria-hidden="true">|</span> : null}
        {children}
      </div>

      {isOpen ? (
        <section
          id={panelId}
          aria-label="Thread goal"
          className="mt-3 rounded-2xl bg-fg/4 px-4 py-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-[0.82em] font-semibold text-text">Goal</h3>
            {!isEditing && !isConfirmingClear ? (
              <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => {
                setDraft(goal.objective);
                setLocalError("");
                setIsEditing(true);
              }}>
                Edit
              </button>
            ) : null}
          </div>

          {isEditing ? (
            <div className="mt-3">
                <label className="text-[0.72em] font-medium text-fg/muted" htmlFor={`${panelId}-objective`}>Objective</label>
                <div className="mt-2 rounded-xl border border-[color-mix(in_srgb,var(--text)_8%,transparent)] bg-[color-mix(in_srgb,var(--bg)_84%,transparent)] [--fg-bg:color-mix(in_srgb,var(--bg)_84%,var(--app-bg-solid))] px-3 py-2.5 focus-within:border-[color-mix(in_srgb,var(--text)_18%,transparent)]">
                  <PlaintextEditable
                    id={`${panelId}-objective`}
                    ariaLabel="Goal objective"
                    className="min-h-24 whitespace-pre-wrap break-words text-[0.84em] leading-[1.6] text-text outline-none"
                    disabled={isPending}
                    onChange={(value) => {
                      setDraft(value);
                      setLocalError("");
                    }}
                    placeholder="Describe the durable objective..."
                    spellCheck
                    value={draft}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className={joinClasses("text-[0.68em] text-fg/muted", draft.length > WORKBENCH_THREAD_GOAL_MAX_LENGTH && "text-danger")}>{draft.length.toLocaleString()} / {WORKBENCH_THREAD_GOAL_MAX_LENGTH.toLocaleString()}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => {
                      setDraft(goal.objective);
                      setLocalError("");
                      setIsEditing(false);
                    }}>Cancel</button>
                    <button type="button" className={quietButtonClassName} disabled={isPending || !objectiveIsValid || objective === goal.objective} onClick={() => { void save(); }}>
                      {pendingAction === "update" ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
            </div>
          ) : (
            <p className="m-0 mt-3 whitespace-pre-wrap text-[0.88em] leading-[1.65] text-text">{goal.objective}</p>
          )}

          {localError ? (
            <div className="mt-3 text-[0.74em] text-danger" role="alert">{localError}</div>
          ) : null}

          {!isEditing ? (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-1">
              {isConfirmingClear ? (
                <>
                  <span className="mr-auto text-[0.72em] text-fg/muted">Clear this goal?</span>
                  <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => setIsConfirmingClear(false)}>Cancel</button>
                  <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => { void clear(); }}>
                    {pendingAction === "clear" ? "Clearing..." : "Clear goal"}
                  </button>
                </>
              ) : (
                <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => setIsConfirmingClear(true)}>Clear goal</button>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

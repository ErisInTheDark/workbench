/*
 * Exports:
 * - default ThreadGoalControl: render the Codex goal flag, objective card, compact editor, and clear confirmation around an agent-tab row.
 */
"use client";

import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";

import type { ThreadPayload, WorkbenchThreadGoalControls } from "workbench-shared/types";
import { FlagIcon } from "../workbench-icons";
import PlaintextEditable from "./PlaintextEditable";

const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;

const statusLabels = {
  blocked: "Blocked",
  budgetLimited: "Budget limited",
  complete: "Complete",
  paused: "Paused",
  usageLimited: "Usage limited",
} as const;

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatTokenCount(value: number) {
  return `${new Intl.NumberFormat().format(value)} ${value === 1 ? "token" : "tokens"}`;
}

function formatElapsedTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m elapsed`;
  if (minutes) return `${minutes}m elapsed`;
  return `${seconds}s elapsed`;
}

const quietButtonClassName = "rounded-lg px-2.5 py-1.5 text-[0.76em] font-medium text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50";

export default function ThreadGoalControl ({
  children,
  controls,
  thread,
}: {
  children?: ReactNode;
  controls: WorkbenchThreadGoalControls;
  thread: Pick<ThreadPayload, "id">;
}) {
  const panelId = useId();
  const subscribe = useCallback((listener: () => void) => controls.subscribe(thread.id, listener), [controls, thread.id]);
  const getSnapshot = useCallback(() => controls.getSnapshot(thread.id), [controls, thread.id]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState("");
  const goal = snapshot.goal;
  const isPending = snapshot.pendingAction !== null;
  const objective = draft.trim();
  const objectiveIsValid = objective.length > 0 && draft.length <= MAX_GOAL_OBJECTIVE_LENGTH;
  const exceptionalStatus = goal?.status === "active" ? null : goal ? statusLabels[goal.status] : null;

  useEffect(() => {
    void controls.load(thread.id);
    setIsOpen(false);
    setIsEditing(false);
    setIsConfirmingClear(false);
    setLocalError("");
    setDraft("");
  }, [controls, thread.id]);

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
  }, [goal?.objective, isEditing, thread.id]);

  if (!snapshot.isLoaded || !goal) {
    return children ? (
      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-0.5">{children}</div>
      </div>
    ) : null;
  }

  const save = async () => {
    if (!objectiveIsValid) {
      setLocalError(objective ? `Goal objectives cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH.toLocaleString()} characters.` : "Goal objectives cannot be empty.");
      return;
    }
    setLocalError("");
    try {
      await controls.updateObjective(thread.id, objective);
      setIsEditing(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to update the thread goal.");
    }
  };

  const clear = async () => {
    setLocalError("");
    try {
      await controls.clear(thread.id);
      setIsConfirmingClear(false);
      setIsEditing(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to clear the thread goal.");
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
          className={joinClasses(
            "inline-flex size-8 items-center justify-center rounded-full text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft",
            goal && "text-text",
          )}
          title={isOpen ? "Hide thread goal" : "Show thread goal"}
          onClick={() => setIsOpen((current) => !current)}
        >
          <FlagIcon size={16} />
        </button>
        {children ? <span className="text-[0.84em] text-fg/muted" aria-hidden="true">|</span> : null}
        {children}
      </div>

      {isOpen ? (
        <section
          id={panelId}
          aria-label="Thread goal"
          className="mt-3 rounded-2xl bg-[color-mix(in_srgb,var(--text)_4%,transparent)] [--goal-panel-bg:color-mix(in_srgb,var(--text)_4%,var(--app-bg-solid))] [--fg-bg:var(--goal-panel-bg)] px-4 py-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="m-0 text-[0.82em] font-semibold text-text">Goal</h3>
              {exceptionalStatus ? (
                <span className="rounded-full bg-[color-mix(in_srgb,var(--text)_7%,transparent)] [--fg-bg:color-mix(in_srgb,var(--text)_7%,var(--goal-panel-bg))] px-2 py-1 text-[0.68em] font-medium text-fg/muted">
                  {exceptionalStatus}
                </span>
              ) : null}
            </div>
            {goal && !isEditing && !isConfirmingClear ? (
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
                <div className="mt-2 rounded-xl border border-[color-mix(in_srgb,var(--text)_8%,transparent)] bg-[color-mix(in_srgb,var(--bg)_84%,transparent)] [--editable-fg-bg:color-mix(in_srgb,var(--bg)_84%,var(--goal-panel-bg))] px-3 py-2.5 focus-within:border-[color-mix(in_srgb,var(--text)_18%,transparent)]">
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
                  <span className={joinClasses("text-[0.68em] text-fg/muted", draft.length > MAX_GOAL_OBJECTIVE_LENGTH && "text-danger")}>{draft.length.toLocaleString()} / {MAX_GOAL_OBJECTIVE_LENGTH.toLocaleString()}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => {
                      setDraft(goal.objective);
                      setLocalError("");
                      setIsEditing(false);
                    }}>Cancel</button>
                    <button type="button" className={quietButtonClassName} disabled={isPending || !objectiveIsValid || objective === goal.objective} onClick={() => { void save(); }}>
                      {snapshot.pendingAction === "update" ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
            </div>
          ) : (
            <>
              <p className="m-0 mt-3 whitespace-pre-wrap text-[0.88em] leading-[1.65] text-text">{goal.objective}</p>
              <p className="m-0 mt-2 text-[0.7em] text-fg/muted">{formatTokenCount(goal.tokensUsed)} <span aria-hidden="true">·</span> {formatElapsedTime(goal.timeUsedSeconds)}</p>
            </>
          )}

          {localError || snapshot.error ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.74em] text-danger" role="alert">
              <span>{localError || snapshot.error}</span>
              {snapshot.error && !isPending ? <button type="button" className={quietButtonClassName} onClick={() => { void controls.refresh(thread.id); }}>Retry</button> : null}
            </div>
          ) : null}

          {goal && !isEditing ? (
            <div className="mt-3 flex flex-wrap items-center justify-end gap-1">
              {isConfirmingClear ? (
                <>
                  <span className="mr-auto text-[0.72em] text-fg/muted">Clear this goal and stop its automatic continuation?</span>
                  <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => setIsConfirmingClear(false)}>Cancel</button>
                  <button type="button" className={quietButtonClassName} disabled={isPending} onClick={() => { void clear(); }}>
                    {snapshot.pendingAction === "clear" ? "Clearing..." : "Clear goal"}
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

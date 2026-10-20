/*
 * Exports:
 * - StepState: where one transcript step is in its life, from its item's outcome.
 * - StepLabels/stepLabels/stepLabel: one tense table per kind of step; timed-out, declined and interrupted wording follows
 *   from the in-progress verb, so every step words those states the same way.
 * - stepStateOf/isFailedStep: map an execution outcome to a step state; whether a state reads as a failure.
 */
import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";

export type StepState = ThreadCommandExecutionOutcome | "interrupted";

export interface StepLabels {
  doing: string;
  done: string;
  failed: string;
  timedOut: string;
  declined: string;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** `doing` is the in-progress verb ("Comparing"); the rest default from it unless a step words them its own way. */
export function stepLabels(doing: string, done: string, failed: string, overrides: Partial<Pick<StepLabels, "declined" | "timedOut">> = {}): StepLabels {
  return {
    doing, done, failed,
    timedOut: overrides.timedOut ?? `Timed out ${lowerFirst(doing)}`,
    declined: overrides.declined ?? `Declined ${lowerFirst(doing)}`,
  };
}

export function stepLabel(labels: StepLabels, state: StepState) {
  switch (state) {
    case "inProgress": return labels.doing;
    case "completed": return labels.done;
    case "failed": return labels.failed;
    case "timedOut": return labels.timedOut;
    case "declined": return labels.declined;
    case "interrupted": return "Interrupted by your steer";
  }
}

export function stepStateOf(outcome: ThreadCommandExecutionOutcome, interrupted = false): StepState {
  return interrupted ? "interrupted" : outcome;
}

export function isFailedStep(state: StepState) {
  return state === "failed" || state === "timedOut" || state === "declined";
}

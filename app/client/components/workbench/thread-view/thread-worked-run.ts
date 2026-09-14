/*
 * Exports:
 * - WorkedRunGate: measured geometry and recorded age of a rendered work run.
 * - WorkedRunState: local collapsed, expanded or awaiting-visible intent.
 * - canCollapseWorkedRun: decide collapse eligibility without timers or DOM access.
 * - workedRunReadyAt: resolve the next age eligibility time, or unknown.
 * - revealWorkedRun/reconcileWorkedRun: pure reveal and off-screen transition state.
 * - partitionWorkedRows: split final rendered rows at protected boundaries.
 */
export interface WorkedRunGate {
  count: number;
  newestActivityAt: number | null;
  initialInactive: boolean;
  above: boolean;
  now: number;
}

export function workedRunReadyAt(gate: Pick<WorkedRunGate, "newestActivityAt" | "initialInactive">) {
  return gate.initialInactive ? 0 : gate.newestActivityAt === null ? null : gate.newestActivityAt + 30 * 60_000 + 1;
}

export function canCollapseWorkedRun(gate: WorkedRunGate) {
  const readyAt = workedRunReadyAt(gate);
  return gate.count >= 5 && gate.above && readyAt !== null && gate.now >= readyAt;
}

export type WorkedRunState = "expanded" | "collapsed" | "awaitingVisible";

export function revealWorkedRun(): WorkedRunState {
  return "awaitingVisible";
}

export function reconcileWorkedRun(state: WorkedRunState, gate: WorkedRunGate, visible: boolean): WorkedRunState {
  if (state === "collapsed") return canCollapseWorkedRun({ ...gate, above: true }) ? state : "expanded";
  if (state === "awaitingVisible") return visible ? "expanded" : state;
  return state === "expanded" && canCollapseWorkedRun(gate) ? "collapsed" : state;
}

export function partitionWorkedRows<T extends { eligible: boolean }>(rows: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const row of rows) {
    const previous = groups.at(-1);
    if (row.eligible && previous?.at(-1)?.eligible) previous.push(row);
    else groups.push([row]);
  }
  return groups;
}

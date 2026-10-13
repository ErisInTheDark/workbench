/*
 * Exports:
 * - WorkedRunGate: measured geometry and recorded age of a rendered work run.
 * - WorkedRunState: local collapse and bottom-reattachment reveal intent.
 * - canCollapseWorkedRun: decide collapse eligibility without timers or DOM access.
 * - workedRunReadyAt: resolve the next age eligibility time, or unknown.
 * - revealWorkedRun/reconcileWorkedRun: pure reveal and off-screen transition state.
 * - SettledItemAdmission/admitSettledItems: items that were already settled when they first appeared.
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
  return gate.count >= 3 && gate.above && readyAt !== null && gate.now >= readyAt;
}

export type WorkedRunState = "expanded" | "collapsed" | "awaitingAttachment";

export function revealWorkedRun(): WorkedRunState {
  return "awaitingAttachment";
}

export function reconcileWorkedRun(state: WorkedRunState, gate: WorkedRunGate, event: "geometry" | "bottomReattached"): WorkedRunState {
  if (state === "collapsed") return canCollapseWorkedRun({ ...gate, above: true }) ? state : "expanded";
  if (state === "awaitingAttachment") return event === "bottomReattached" ? "expanded" : state;
  return state === "expanded" && canCollapseWorkedRun(gate) ? "collapsed" : state;
}

export interface SettledItemAdmission {
  /** Grows in place; only `settled` changes identity, so live appends never re-render settled turns. */
  readonly known: Set<string>;
  readonly settled: ReadonlySet<string>;
}

/**
 * Items already settled when they first appear (opening the thread, or history landing above) start collapsible.
 * Anything arriving below what was shown is activity being watched and keeps its live state after its turn ends.
 */
export function admitSettledItems(
  previous: SettledItemAdmission | null,
  turns: readonly { readonly id: string; readonly items: readonly { readonly id: string }[] }[],
  liveTurnId: string | null,
): SettledItemAdmission {
  const known = previous?.known ?? new Set<string>();
  const ordered = turns.flatMap(turn => turn.items.map(item => ({ id: item.id, live: turn.id === liveTurnId })));
  let newestKnown = -1;
  for (let index = ordered.length - 1; index >= 0 && newestKnown < 0; index -= 1) {
    if (known.has(ordered[index]!.id)) newestKnown = index;
  }
  const settled: string[] = [];
  ordered.forEach((item, index) => {
    if (known.has(item.id)) return;
    known.add(item.id);
    // On open everything outside the live turn is settled; later, only history landing above known items is.
    if (!item.live && (!previous || index < newestKnown)) settled.push(item.id);
  });
  if (previous && !settled.length) return previous;
  return { known, settled: new Set([...(previous?.settled ?? []), ...settled]) };
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

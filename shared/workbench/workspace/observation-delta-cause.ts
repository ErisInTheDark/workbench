/*
 * Exports:
 * - ObservationDeltaCause: what one workspace delta means, for traffic logs; `heartbeat` causes carry no news.
 * - observationDeltaCause: classify a delta by the fields and keyed collections it changed; null when no cause fits.
 */
import type { ObservationDelta } from "./observation-patch";

export interface ObservationDeltaCause {
  cause: string;
  /** Routine ticks (activity timestamps, token usage) a working thread emits every step; logs omit them. */
  heartbeat: boolean;
}

type CauseRule = ObservationDeltaCause & ({ fields: ReadonlySet<string> } | { collections: ReadonlySet<string> });

/**
 * First match wins. Field rules need every changed field inside the set and no item added, removed or moved; collection
 * rules need every changed keyed collection inside the set, whatever their items' fields.
 */
const CAUSES: readonly CauseRule[] = [
  { cause: "activity", heartbeat: true, fields: new Set(["activityAt", "lastThreadUpdateAt", "tokenUsage"]) },
  {
    cause: "draft saved", heartbeat: false,
    collections: new Set(["composerDrafts", "composerDraftAttachments", "composerDraftReferences"]),
  },
  { cause: "selection saved", heartbeat: false, collections: new Set(["lastProjectSelections", "lastProjectSelectionProjects"]) },
];

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** Bookkeeping that rides along with real changes. */
const INCIDENTAL = new Set(["revision"]);

interface Changes {
  fields: Set<string>;
  collections: Set<string>;
  /** An item was added, removed, moved or replaced whole: not a field-level change. */
  structural: boolean;
}

function collect(delta: ObservationDelta, changes: Changes) {
  for (const field of [...Object.keys(delta.set ?? {}), ...delta.unset ?? []]) {
    if (ID.test(field)) changes.structural = true;
    else if (!INCIDENTAL.has(field)) changes.fields.add(field);
  }
  for (const nested of Object.values(delta.objects ?? {})) collect(nested, changes);
  for (const [name, keyed] of Object.entries(delta.collections ?? {})) {
    changes.collections.add(name);
    if (keyed.add?.length || keyed.remove?.length || keyed.move?.length) changes.structural = true;
    for (const update of keyed.update ?? []) collect(update.delta, changes);
  }
}

const within = (values: ReadonlySet<string>, allowed: ReadonlySet<string>) =>
  values.size > 0 && [...values].every(value => allowed.has(value));

export function observationDeltaCause(delta: ObservationDelta): ObservationDeltaCause | null {
  const changes: Changes = { fields: new Set(), collections: new Set(), structural: false };
  collect(delta, changes);
  const rule = CAUSES.find(candidate => "fields" in candidate
    ? !changes.structural && within(changes.fields, candidate.fields)
    : within(changes.collections, candidate.collections));
  return rule ? { cause: rule.cause, heartbeat: rule.heartbeat } : null;
}

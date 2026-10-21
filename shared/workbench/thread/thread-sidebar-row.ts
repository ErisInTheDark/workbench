/*
 * Exports:
 * - WorkbenchSidebarGitArcSchema/WorkbenchSidebarGitArc: re-exported lean Git work for sidebar rows.
 * - WorkbenchSidebarGitArcPlanSchema/WorkbenchSidebarGitArcPlan: inactive-plan scope a sidebar row needs for collisions.
 * - WorkbenchSidebarSubagentClaimsSchema/WorkbenchSidebarSubagentClaims: a parent's direct subagents holding active claims.
 * - WorkbenchThreadSidebarRowVersionSchema: the row version older browsers still request; rows no longer differ by it.
 * - WorkbenchThreadSidebarRowSchema/WorkbenchThreadSidebarRow: lean list-rendering row; per-thread detail rides the thread observation.
 * - WorkbenchThreadSidebarThreadRowSchema/WorkbenchThreadSidebarThreadRow: the lean row of a provider thread or subagent.
 * - WorkbenchThreadSidebarRowSnapshotSchema/WorkbenchThreadSidebarRowSnapshot: one project's unarchived rows plus its archived count.
 * - WorkbenchProjectThreadRowSidebars: client store collection of row snapshots.
 * - projectSidebarRow: strip a full entry (or re-project a row) to its lean row.
 * - projectSidebarRowSnapshot: lean rows for one project's sidebar: no archived threads and no subagents, whose active claims fold onto their parents.
 * - sidebarRowKey: stable row identity shared by every delta hop.
 * - coarseActivity: ten-second activity timestamps for observations.
 */
import { z } from "zod";
import {
  settleWorkbenchQuestionnaireWait, WorkbenchSidebarGitArcSchema, WorkbenchThreadSidebarEntryVariants, type WorkbenchSidebarGitArc,
  type WorkbenchThreadSidebarEntry,
  WorkbenchThreadSidebarSnapshotSchema, type WorkbenchThreadSidebarSnapshot,
} from "./thread-state";
import { getThreadDisplayDraftKey, getThreadDisplayThreadKey } from "./thread-display-layout";
import { areDeeplyEqual } from "../deep-equality";
import { WorkbenchThreadIdSchema } from "../identity";

export { WorkbenchSidebarGitArcSchema, type WorkbenchSidebarGitArc } from "./thread-state";
const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
const paths = z.array(z.string().min(1));
export const WorkbenchSidebarGitArcPlanSchema = z.object({ checkpointCommit: commit, scopePaths: paths }).strict();
export type WorkbenchSidebarGitArcPlan = z.infer<typeof WorkbenchSidebarGitArcPlanSchema>;
/** Subagents live in their parent's thread tabs, never as sidebar rows, so the parent row carries what its badge needs. */
export const WorkbenchSidebarSubagentClaimsSchema = z.array(z.object({
  threadId: WorkbenchThreadIdSchema, parentThreadId: WorkbenchThreadIdSchema, name: z.string(), title: z.string(),
  directSubagentIndex: z.number().int().nonnegative(), claimedPaths: paths,
}).strict());
export type WorkbenchSidebarSubagentClaims = z.infer<typeof WorkbenchSidebarSubagentClaimsSchema>;

const heavy = { questionnaireHistory: true, previousTitles: true, gitArc: true, gitArcPlan: true, gitCommitHistory: true, profile: true } as const;
const lean = {
  gitArc: WorkbenchSidebarGitArcSchema.nullable().optional(),
  gitArcPlan: WorkbenchSidebarGitArcPlanSchema.nullable().optional(),
  /** Older daemons still send it; current rows leave live facts to thread summaries. */
  compacting: z.boolean().optional(),
};
/** Older browsers still ask for row version 2; rows no longer differ by version. */
export const WorkbenchThreadSidebarRowVersionSchema = z.literal(2);
const ThreadRowSchema = WorkbenchThreadSidebarEntryVariants.thread.omit(heavy)
  .extend({ ...lean, subagentClaims: WorkbenchSidebarSubagentClaimsSchema.optional() }).strict()
  .transform(settleWorkbenchQuestionnaireWait);
const SubagentRowSchema = WorkbenchThreadSidebarEntryVariants.subagent.omit(heavy).extend(lean).strict()
  .superRefine(WorkbenchThreadSidebarEntryVariants.refineSubagent)
  .transform(settleWorkbenchQuestionnaireWait);
export const WorkbenchThreadSidebarRowSchema = z.discriminatedUnion("entryKind", [
  WorkbenchThreadSidebarEntryVariants.draft, ThreadRowSchema, SubagentRowSchema,
]);
export type WorkbenchThreadSidebarRow = z.infer<typeof WorkbenchThreadSidebarRowSchema>;
/** A provider thread's or subagent's lean row; drafts have no thread of their own. */
export const WorkbenchThreadSidebarThreadRowSchema = z.discriminatedUnion("entryKind", [ThreadRowSchema, SubagentRowSchema]);
export type WorkbenchThreadSidebarThreadRow = z.infer<typeof WorkbenchThreadSidebarThreadRowSchema>;

export const WorkbenchThreadSidebarRowSnapshotSchema = WorkbenchThreadSidebarSnapshotSchema.extend({
  entries: z.array(WorkbenchThreadSidebarRowSchema),
  archivedCount: z.number().int().nonnegative().optional(),
}).strict();
export type WorkbenchThreadSidebarRowSnapshot = z.infer<typeof WorkbenchThreadSidebarRowSnapshotSchema>;
export type WorkbenchProjectThreadRowSidebars = { projects: WorkbenchThreadSidebarRowSnapshot[] };

type RowSource = WorkbenchThreadSidebarEntry | WorkbenchThreadSidebarRow;

export function sidebarRowKey(row: RowSource) {
  return row.entryKind === "draft"
    ? getThreadDisplayDraftKey(row.draft.draftId)
    : getThreadDisplayThreadKey(row.identity.harness, row.identity.threadId);
}

function leanArc(arc: NonNullable<Exclude<RowSource, { entryKind: "draft" }>["gitArc"]>): WorkbenchSidebarGitArc {
  const base = { checkpointCommit: arc.checkpointCommit, ...(arc.stashedPaths?.length ? { stashedPaths: arc.stashedPaths } : {}), proposals: arc.proposals.map(({ proposalId, rootId, status }) => (
    rootId ? { proposalId, rootId, status } : { proposalId, status })) };
  if (arc.phase === "active") return { ...base, phase: "active", claimedPaths: arc.claimedPaths as [string, ...string[]] };
  if (arc.phase === "stashed") return { ...base, phase: "stashed", claimedPaths: [], stashedPaths: arc.stashedPaths as [string, ...string[]] };
  return { ...base, phase: "resolved", claimedPaths: [] };
}

// Null and absent mean the same for these; storage reads yield null while in-memory rewrites omit them,
// so rows canonicalise to absent or the same row would flip between the two on every refresh.
const nullableOptional = ["pendingQuestionnaire", "gitArc", "gitArcPlan"] as const;
/** Observations carry activity to whole seconds, so a burst of agent items inside one second is one tick. */
/**
 * Labels read "just now" until 45s and then whole minutes, so per-second activity only cost one push per active
 * thread per second across every observation; ten seconds keeps labels exact at a tenth of the traffic.
 */
const ACTIVITY_GRANULARITY_MS = 10_000;
export const coarseActivity = (ms: number) => ms - ms % ACTIVITY_GRANULARITY_MS;

const isLean = (entry: Exclude<RowSource, { entryKind: "draft" }>) => entry.activityAt % 1_000 === 0
  && !("questionnaireHistory" in entry)
  && !("previousTitles" in entry) && !("gitCommitHistory" in entry) && !("profile" in entry) && !(entry.gitArc && "intentName" in entry.gitArc)
  && !(entry.gitArcPlan && "intentName" in entry.gitArcPlan)
  && nullableOptional.every(field => !(field in entry) || entry[field] !== null)
  && !("compacting" in entry);

/** Idempotent and identity-preserving: an already-lean row is returned as-is, so keyed diffs short-circuit. */
export function projectSidebarRow(entry: RowSource): WorkbenchThreadSidebarRow {
  if (entry.entryKind === "draft") return entry;
  if (isLean(entry)) return entry as WorkbenchThreadSidebarRow;
  const {
    questionnaireHistory: _history, previousTitles: _titles, gitArc, gitArcPlan, gitCommitHistory: _commits, profile: _profile,
    pendingQuestionnaire, compacting: _compacting, ...rest
  } = entry as Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> & { compacting?: boolean };
  return {
    ...rest,
    activityAt: coarseActivity(rest.activityAt),
    ...(pendingQuestionnaire ? { pendingQuestionnaire } : {}),
    ...(gitArc ? { gitArc: leanArc(gitArc) } : {}),
    ...(gitArcPlan ? { gitArcPlan: { checkpointCommit: gitArcPlan.checkpointCommit, scopePaths: gitArcPlan.scopePaths } } : {}),
  } as WorkbenchThreadSidebarRow;
}

/** Direct subagents' active claims per parent; null when the snapshot lists no subagents (already folded). */
function subagentClaimsByParent(entries: readonly RowSource[]) {
  if (!entries.some(entry => entry.entryKind === "subagent")) return null;
  const claims = new Map<string, WorkbenchSidebarSubagentClaims>();
  for (const entry of entries) {
    if (entry.entryKind !== "subagent" || entry.gitArc?.phase !== "active") continue;
    const parent = claims.get(entry.parentThreadId) ?? [];
    parent.push({
      threadId: entry.identity.threadId, parentThreadId: entry.parentThreadId, name: entry.name, title: entry.title,
      directSubagentIndex: entry.directSubagentIndex, claimedPaths: entry.gitArc.claimedPaths,
    });
    claims.set(entry.parentThreadId, parent);
  }
  return claims;
}

function withSubagentClaims(row: WorkbenchThreadSidebarRow, claims: WorkbenchSidebarSubagentClaims | undefined) {
  if (row.entryKind !== "thread" || areDeeplyEqual(row.subagentClaims, claims)) return row;
  const { subagentClaims: _previous, ...rest } = row;
  return claims ? { ...rest, subagentClaims: claims } : rest;
}

export function projectSidebarRowSnapshot(
  snapshot: WorkbenchThreadSidebarSnapshot | WorkbenchThreadSidebarRowSnapshot,
): WorkbenchThreadSidebarRowSnapshot {
  const archived = new Set(snapshot.entries.flatMap(entry => entry.entryKind === "thread" && entry.metadata.archived ? [entry.identity.threadId] : []));
  const claims = subagentClaimsByParent(snapshot.entries);
  let unchanged = true;
  const entries = snapshot.entries.flatMap(entry => {
    if (entry.entryKind === "subagent" || (entry.entryKind === "thread" && entry.metadata.archived)) {
      unchanged = false;
      return [];
    }
    const lean = projectSidebarRow(entry);
    const row = claims && lean.entryKind === "thread" ? withSubagentClaims(lean, claims.get(lean.identity.threadId)) : lean;
    if (row !== entry) unchanged = false;
    return [row];
  });
  const previous = "archivedCount" in snapshot ? snapshot.archivedCount ?? 0 : 0;
  if (unchanged && "archivedCount" in snapshot) return snapshot as WorkbenchThreadSidebarRowSnapshot;
  return { ...snapshot, entries, archivedCount: previous + archived.size };
}

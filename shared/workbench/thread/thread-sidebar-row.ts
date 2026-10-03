/*
 * Exports:
 * - WorkbenchSidebarGitArcSchema/WorkbenchSidebarGitArc: Git arc facts a sidebar row needs; live paths only for active/stashed arcs.
 * - WorkbenchSidebarGitArcPlanSchema/WorkbenchSidebarGitArcPlan: inactive-plan scope a sidebar row needs for collisions.
 * - WorkbenchThreadSidebarRowSchema/WorkbenchThreadSidebarRow: lean list-rendering row; per-thread detail rides the thread observation.
 * - WorkbenchThreadSidebarRowSnapshotSchema/WorkbenchThreadSidebarRowSnapshot: one project's unarchived rows plus its archived count.
 * - WorkbenchProjectThreadRowSidebars: client store collection of row snapshots.
 * - projectSidebarRow: strip a full entry (or re-project a row) to its lean row.
 * - projectSidebarRowSnapshot: lean rows for one project's sidebar, excluding archived threads and their subagents.
 * - sidebarRowKey: stable row identity shared by every delta hop.
 */
import { z } from "zod";
import { WorkbenchThreadSidebarEntryVariants, type WorkbenchThreadSidebarEntry, WorkbenchThreadSidebarSnapshotSchema, type WorkbenchThreadSidebarSnapshot } from "./thread-state";
import { getThreadDisplayDraftKey, getThreadDisplayThreadKey } from "./thread-display-layout";

const commit = z.string().regex(/^[a-f0-9]{40,64}$/u);
const paths = z.array(z.string().min(1));
const proposals = z.array(z.object({
  proposalId: z.string().min(1), rootId: z.string().min(1).optional(), status: z.enum(["committed", "proposed"]),
}).strict());
export const WorkbenchSidebarGitArcSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("active"), checkpointCommit: commit, proposals, claimedPaths: paths.min(1) }).strict(),
  z.object({ phase: z.literal("stashed"), checkpointCommit: commit, proposals, claimedPaths: paths.length(0), stashedPaths: paths.min(1) }).strict(),
  z.object({ phase: z.literal("resolved"), checkpointCommit: commit, proposals, claimedPaths: paths.length(0) }).strict(),
]);
export type WorkbenchSidebarGitArc = z.infer<typeof WorkbenchSidebarGitArcSchema>;
export const WorkbenchSidebarGitArcPlanSchema = z.object({ checkpointCommit: commit, scopePaths: paths }).strict();
export type WorkbenchSidebarGitArcPlan = z.infer<typeof WorkbenchSidebarGitArcPlanSchema>;

const heavy = { questionnaireHistory: true, previousTitles: true, gitArc: true, gitArcPlan: true } as const;
const lean = {
  gitArc: WorkbenchSidebarGitArcSchema.nullable().optional(),
  gitArcPlan: WorkbenchSidebarGitArcPlanSchema.nullable().optional(),
};
const ThreadRowSchema = WorkbenchThreadSidebarEntryVariants.thread.omit(heavy).extend(lean).strict();
const SubagentRowSchema = WorkbenchThreadSidebarEntryVariants.subagent.omit(heavy).extend(lean).strict()
  .superRefine(WorkbenchThreadSidebarEntryVariants.refineSubagent);
export const WorkbenchThreadSidebarRowSchema = z.discriminatedUnion("entryKind", [
  WorkbenchThreadSidebarEntryVariants.draft, ThreadRowSchema, SubagentRowSchema,
]);
export type WorkbenchThreadSidebarRow = z.infer<typeof WorkbenchThreadSidebarRowSchema>;

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
  const base = { checkpointCommit: arc.checkpointCommit, proposals: arc.proposals.map(({ proposalId, rootId, status }) => (
    rootId ? { proposalId, rootId, status } : { proposalId, status })) };
  if (arc.phase === "active") return { ...base, phase: "active", claimedPaths: arc.claimedPaths as [string, ...string[]] };
  if (arc.phase === "stashed") return { ...base, phase: "stashed", claimedPaths: [], stashedPaths: arc.stashedPaths as [string, ...string[]] };
  return { ...base, phase: "resolved", claimedPaths: [] };
}

// Null and absent mean the same for these; storage reads yield null while in-memory rewrites omit them,
// so rows canonicalise to absent or the same row would flip between the two on every refresh.
const nullableOptional = ["pendingQuestionnaire", "gitArc", "gitArcPlan"] as const;
const isLean = (entry: Exclude<RowSource, { entryKind: "draft" }>) => !("questionnaireHistory" in entry)
  && !("previousTitles" in entry) && !(entry.gitArc && "intentName" in entry.gitArc)
  && !(entry.gitArcPlan && "intentName" in entry.gitArcPlan)
  && nullableOptional.every(field => !(field in entry) || entry[field] !== null);

/** Idempotent and identity-preserving: an already-lean row is returned as-is, so keyed diffs short-circuit. */
export function projectSidebarRow(entry: RowSource): WorkbenchThreadSidebarRow {
  if (entry.entryKind === "draft") return entry;
  if (isLean(entry)) return entry as WorkbenchThreadSidebarRow;
  const { questionnaireHistory: _history, previousTitles: _titles, gitArc, gitArcPlan, pendingQuestionnaire, ...rest } = entry as Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>;
  return {
    ...rest,
    ...(pendingQuestionnaire ? { pendingQuestionnaire } : {}),
    ...(gitArc ? { gitArc: leanArc(gitArc) } : {}),
    ...(gitArcPlan ? { gitArcPlan: { checkpointCommit: gitArcPlan.checkpointCommit, scopePaths: gitArcPlan.scopePaths } } : {}),
  } as WorkbenchThreadSidebarRow;
}

export function projectSidebarRowSnapshot(snapshot: WorkbenchThreadSidebarSnapshot | WorkbenchThreadSidebarRowSnapshot): WorkbenchThreadSidebarRowSnapshot {
  const archived = new Set(snapshot.entries.flatMap(entry => entry.entryKind === "thread" && entry.metadata.archived ? [entry.identity.threadId] : []));
  let unchanged = true;
  const entries = snapshot.entries.flatMap(entry => {
    if ((entry.entryKind === "thread" && entry.metadata.archived)
      || (entry.entryKind === "subagent" && archived.has(entry.parentThreadId))) {
      unchanged = false;
      return [];
    }
    const row = projectSidebarRow(entry);
    if (row !== entry) unchanged = false;
    return [row];
  });
  const previous = "archivedCount" in snapshot ? snapshot.archivedCount ?? 0 : 0;
  if (unchanged && "archivedCount" in snapshot) return snapshot as WorkbenchThreadSidebarRowSnapshot;
  return { ...snapshot, entries, archivedCount: previous + archived.size };
}

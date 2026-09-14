/*
 * Exports:
 * - default WorkbenchThreadStateGitRepository: read and replace one thread's typed Git observations.
 * - WorkbenchThreadGitObservations: independently absent, null or populated arc and plan cache.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  WorkbenchGitArcLifecycleStateSchema, WorkbenchGitArcPlanStateSchema,
  type WorkbenchGitArcLifecycleState, type WorkbenchGitArcPlanState,
} from "workbench-shared/workbench/thread/thread-state";

export interface WorkbenchThreadGitObservations {
  gitArc?: WorkbenchGitArcLifecycleState | null;
  gitArcPlan?: WorkbenchGitArcPlanState | null;
}

type ObservationKind = "arc" | "plan";
type GitEntry = {
  id: string;
  entry_kind: "summary" | "member";
  entry_index: number;
  checkpoint_commit: string;
  intent_name: string;
  intent_description: string;
  updated_at: string;
  phase: "active" | "resolved" | null;
  harness: string | null;
  thread_id: string | null;
  repo_root: string | null;
  root_id: string | null;
};
type ArcMember = NonNullable<WorkbenchGitArcLifecycleState["members"]>[number];
type PlanMember = NonNullable<WorkbenchGitArcPlanState["members"]>[number];

export default class WorkbenchThreadStateGitRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkbenchThreadGitObservations {
    const observations = this.database.prepare(`
      SELECT id, observation_kind, has_value FROM workbench_thread_git_observations WHERE thread_id = ?
    `).all(threadId) as Array<{ id: string; observation_kind: ObservationKind; has_value: 0 | 1 }>;
    const result: WorkbenchThreadGitObservations = {};
    for (const observation of observations) {
      if (!observation.has_value) {
        if (observation.observation_kind === "arc") result.gitArc = null;
        else result.gitArcPlan = null;
        continue;
      }
      const entries = this.database.prepare(`
        SELECT * FROM workbench_thread_git_entries WHERE observation_id = ? ORDER BY entry_kind, entry_index
      `).all(observation.id) as GitEntry[];
      const summaries = entries.filter((entry) => entry.entry_kind === "summary");
      if (summaries.length !== 1) throw new Error("Git observation has no unique summary.");
      const summary = summaries[0]!;
      const members = entries.filter((entry) => entry.entry_kind === "member");
      this.requireOrdered(members.map((entry) => entry.entry_index));
      if (observation.observation_kind === "arc") {
        result.gitArc = WorkbenchGitArcLifecycleStateSchema.parse({
          ...this.readBase(summary),
          phase: summary.phase,
          claimedPaths: this.readPaths(summary.id),
          proposals: this.readProposals(summary.id),
          ...(members.length ? {
            members: members.map((entry) => ({
              ...this.readBase(entry), ...this.readMember(entry), phase: entry.phase,
              claimedPaths: this.readPaths(entry.id), proposals: this.readProposals(entry.id),
            })),
          } : {}),
        });
      } else {
        result.gitArcPlan = WorkbenchGitArcPlanStateSchema.parse({
          ...this.readBase(summary),
          scopePaths: this.readPaths(summary.id),
          ...(members.length ? {
            members: members.map((entry) => ({
              ...this.readBase(entry), ...this.readMember(entry), scopePaths: this.readPaths(entry.id),
            })),
          } : {}),
        });
      }
    }
    return result;
  }

  replace(threadId: string, value: WorkbenchThreadGitObservations) {
    const arc = value.gitArc == null ? value.gitArc : WorkbenchGitArcLifecycleStateSchema.parse(value.gitArc);
    const plan = value.gitArcPlan == null ? value.gitArcPlan : WorkbenchGitArcPlanStateSchema.parse(value.gitArcPlan);
    this.database.transaction(() => {
      this.writeObservation(threadId, "arc", arc);
      this.writeObservation(threadId, "plan", plan);
    })();
  }

  private writeObservation(
    threadId: string, kind: ObservationKind,
    value: WorkbenchGitArcLifecycleState | WorkbenchGitArcPlanState | null | undefined,
  ) {
    const existing = this.database.prepare(`
      SELECT id FROM workbench_thread_git_observations WHERE thread_id = ? AND observation_kind = ?
    `).get(threadId, kind) as { id: string } | undefined;
    if (value === undefined) {
      if (existing) this.database.prepare("DELETE FROM workbench_thread_git_observations WHERE id = ?").run(existing.id);
      return;
    }
    const id = existing?.id ?? randomUUID();
    if (existing) this.database.prepare("DELETE FROM workbench_thread_git_entries WHERE observation_id = ?").run(id);
    this.database.prepare(`
      INSERT INTO workbench_thread_git_observations(id, thread_id, observation_kind, has_value)
      VALUES (?, ?, ?, ?) ON CONFLICT(thread_id, observation_kind) DO UPDATE SET has_value = excluded.has_value
    `).run(id, threadId, kind, value === null ? 0 : 1);
    if (value === null) return;
    this.writeEntry(id, kind, value, 0);
    value.members?.forEach((member, memberIndex) => this.writeEntry(id, kind, member, memberIndex, member));
  }

  private writeEntry(
    observationId: string, kind: ObservationKind,
    value: WorkbenchGitArcLifecycleState | WorkbenchGitArcPlanState | ArcMember | PlanMember,
    index: number, member?: ArcMember | PlanMember,
  ) {
    const id = randomUUID();
    const arc = "claimedPaths" in value;
    this.database.prepare(`
      INSERT INTO workbench_thread_git_entries(
        id, observation_id, observation_kind, has_value, entry_kind, entry_index,
        checkpoint_commit, intent_name, intent_description, updated_at, phase, harness, thread_id, repo_root, root_id
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, observationId, kind, member ? "member" : "summary", index,
      value.checkpointCommit, value.intentName, value.intentDescription, value.updatedAt,
      arc ? value.phase : null, member?.harness ?? null, member?.threadId ?? null,
      member?.repoRoot ?? null, member?.rootId ?? null,
    );
    const insertPath = this.database.prepare(`
      INSERT INTO workbench_thread_git_paths(entry_id, path_index, path) VALUES (?, ?, ?)
    `);
    (arc ? value.claimedPaths : value.scopePaths).forEach((path, pathIndex) => insertPath.run(id, pathIndex, path));
    if (arc) {
      const insertProposal = this.database.prepare(`
        INSERT INTO workbench_thread_git_proposals(entry_id, observation_kind, proposal_index, proposal_id, root_id, status)
        VALUES (?, 'arc', ?, ?, ?, ?)
      `);
      value.proposals.forEach((proposal, proposalIndex) => {
        insertProposal.run(id, proposalIndex, proposal.proposalId, proposal.rootId ?? null, proposal.status);
      });
    }
    if (member) {
      const insertRoot = this.database.prepare(`
        INSERT INTO workbench_thread_git_member_roots(entry_id, entry_kind, root_index, root_id) VALUES (?, 'member', ?, ?)
      `);
      member.rootIds.forEach((rootId, rootIndex) => insertRoot.run(id, rootIndex, rootId));
    }
  }

  private readBase(entry: GitEntry) {
    return {
      checkpointCommit: entry.checkpoint_commit,
      intentName: entry.intent_name,
      intentDescription: entry.intent_description,
      updatedAt: entry.updated_at,
    };
  }

  private readMember(entry: GitEntry) {
    const roots = this.database.prepare(`
      SELECT root_index, root_id FROM workbench_thread_git_member_roots WHERE entry_id = ? ORDER BY root_index
    `).all(entry.id) as Array<{ root_index: number; root_id: string }>;
    this.requireOrdered(roots.map((root) => root.root_index));
    return {
      harness: entry.harness, threadId: entry.thread_id, repoRoot: entry.repo_root, rootId: entry.root_id,
      rootIds: roots.map((root) => root.root_id),
    };
  }

  private readPaths(entryId: string) {
    const paths = this.database.prepare(`
      SELECT path_index, path FROM workbench_thread_git_paths WHERE entry_id = ? ORDER BY path_index
    `).all(entryId) as Array<{ path_index: number; path: string }>;
    this.requireOrdered(paths.map((path) => path.path_index));
    return paths.map((path) => path.path);
  }

  private readProposals(entryId: string) {
    const proposals = this.database.prepare(`
      SELECT proposal_index, proposal_id, root_id, status FROM workbench_thread_git_proposals
      WHERE entry_id = ? ORDER BY proposal_index
    `).all(entryId) as Array<{
      proposal_index: number; proposal_id: string; root_id: string | null; status: "committed" | "proposed";
    }>;
    this.requireOrdered(proposals.map((proposal) => proposal.proposal_index));
    return proposals.map((proposal) => ({
      proposalId: proposal.proposal_id, status: proposal.status,
      ...(proposal.root_id === null ? {} : { rootId: proposal.root_id }),
    }));
  }

  private requireOrdered(indices: readonly number[]) {
    if (indices.some((index, position) => index !== position)) throw new Error("Git observation has incomplete ordered facts.");
  }
}

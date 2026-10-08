/*
 * Exports:
 * - default WorkbenchThreadStateGitRepository: read, project and replace one thread's typed Git observation startup cache.
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
  phase: "active" | "stashed" | "resolved" | null;
  harness: string | null;
  thread_id: string | null;
  repo_root: string | null;
  root_id: string | null;
};
type ArcMember = NonNullable<WorkbenchGitArcLifecycleState["members"]>[number];
type PlanMember = NonNullable<WorkbenchGitArcPlanState["members"]>[number];
type GitObservationRow = { id: string; thread_id: string; observation_kind: ObservationKind; has_value: 0 | 1 };
type GitPathRow = { entry_id: string; path_index: number; path: string };
type GitRootRow = { entry_id: string; root_index: number; root_id: string };
type GitProposalRow = { entry_id: string; proposal_index: number; proposal_id: string; root_id: string | null; status: "committed" | "proposed" };
interface GitReadBatch {
  entries: Map<string, GitEntry[]>;
  paths: Map<string, GitPathRow[]>;
  roots: Map<string, GitRootRow[]>;
  proposals: Map<string, GitProposalRow[]>;
}

export default class WorkbenchThreadStateGitRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkbenchThreadGitObservations {
    return this.readMany([threadId]).get(threadId)!;
  }

  readMany(threadIds: readonly string[]): Map<string, WorkbenchThreadGitObservations> {
    const result = new Map<string, WorkbenchThreadGitObservations>();
    for (let offset = 0; offset < threadIds.length; offset += 400) {
      const ids = threadIds.slice(offset, offset + 400);
      const placeholders = ids.map(() => "?").join(",");
      const observationSelection = `SELECT id FROM workbench_thread_git_observations WHERE thread_id IN (${placeholders})`;
      const entrySelection = `SELECT id FROM workbench_thread_git_entries WHERE observation_id IN (${observationSelection})`;
      const observations = this.database.prepare(`SELECT * FROM workbench_thread_git_observations WHERE thread_id IN (${placeholders})`)
        .all(...ids) as GitObservationRow[];
      const entries = this.database.prepare(`SELECT * FROM workbench_thread_git_entries WHERE observation_id IN (${observationSelection}) ORDER BY entry_kind, entry_index`)
        .all(...ids) as Array<GitEntry & { observation_id: string }>;
      const paths = this.database.prepare(`SELECT * FROM workbench_thread_git_paths WHERE entry_id IN (${entrySelection}) ORDER BY path_index`)
        .all(...ids) as GitPathRow[];
      const roots = this.database.prepare(`SELECT * FROM workbench_thread_git_member_roots WHERE entry_id IN (${entrySelection}) ORDER BY root_index`)
        .all(...ids) as GitRootRow[];
      const proposals = this.database.prepare(`SELECT * FROM workbench_thread_git_proposals WHERE entry_id IN (${entrySelection}) ORDER BY proposal_index`)
        .all(...ids) as GitProposalRow[];
      const batch: GitReadBatch = {
        entries: Map.groupBy(entries, entry => entry.observation_id),
        paths: Map.groupBy(paths, entry => entry.entry_id),
        roots: Map.groupBy(roots, entry => entry.entry_id),
        proposals: Map.groupBy(proposals, entry => entry.entry_id),
      };
      const byThread = Map.groupBy(observations, observation => observation.thread_id);
      for (const id of ids) result.set(id, this.decode(byThread.get(id) ?? [], batch));
    }
    return result;
  }

  private decode(observations: readonly GitObservationRow[], batch: GitReadBatch): WorkbenchThreadGitObservations {
    const result: WorkbenchThreadGitObservations = {};
    for (const observation of observations) {
      if (!observation.has_value) {
        if (observation.observation_kind === "arc") result.gitArc = null;
        else result.gitArcPlan = null;
        continue;
      }
      const entries = batch.entries.get(observation.id) ?? [];
      const summaries = entries.filter((entry) => entry.entry_kind === "summary");
      if (summaries.length !== 1) throw new Error("Git observation has no unique summary.");
      const summary = summaries[0]!;
      const members = entries.filter((entry) => entry.entry_kind === "member");
      this.requireOrdered(members.map((entry) => entry.entry_index));
      if (observation.observation_kind === "arc") {
        result.gitArc = WorkbenchGitArcLifecycleStateSchema.parse({
          ...this.readBase(summary),
          ...this.readArcPaths(summary, batch),
          proposals: this.readProposals(summary.id, batch),
          ...(members.length ? {
            members: members.map((entry) => ({
              ...this.readBase(entry), ...this.readMember(entry, batch), ...this.readArcPaths(entry, batch),
              proposals: this.readProposals(entry.id, batch),
            })),
          } : {}),
        });
      } else {
        result.gitArcPlan = WorkbenchGitArcPlanStateSchema.parse({
          ...this.readBase(summary),
          scopePaths: this.readPaths(summary.id, batch),
          ...(members.length ? {
            members: members.map((entry) => ({
              ...this.readBase(entry), ...this.readMember(entry, batch), scopePaths: this.readPaths(entry.id, batch),
            })),
          } : {}),
        });
      }
    }
    return result;
  }

  /**
   * The persisted startup-cache subset of live observations: exactly what `read` returns after `replace(value)`.
   * Git-derived facts outside it (proposal summaries, stack layers, acceptance, saved stash beside live claims) are
   * never cached, so they cannot drift; compare against this, not the live value, to skip unchanged writes.
   */
  project(value: WorkbenchThreadGitObservations): WorkbenchThreadGitObservations {
    const arcPaths = (arc: { claimedPaths: string[]; phase: string; stashedPaths?: string[] }) => arc.phase === "stashed"
      ? { claimedPaths: [], phase: arc.phase, stashedPaths: arc.stashedPaths ?? [] }
      : { claimedPaths: arc.claimedPaths, phase: arc.phase };
    const base = ({ checkpointCommit, intentDescription, intentName, updatedAt }: WorkbenchGitArcPlanState | ArcMember | PlanMember | WorkbenchGitArcLifecycleState) => (
      { checkpointCommit, intentName, intentDescription, updatedAt }
    );
    const member = ({ harness, repoRoot, rootId, rootIds, threadId }: ArcMember | PlanMember) => ({ harness, threadId, repoRoot, rootId, rootIds });
    const proposals = (values: WorkbenchGitArcLifecycleState["proposals"]) => values.map(({ proposalId, rootId, status }) => (
      { proposalId, status, ...(rootId === undefined ? {} : { rootId }) }
    ));
    const result: WorkbenchThreadGitObservations = {};
    if (value.gitArc !== undefined) {
      const arc = value.gitArc;
      result.gitArc = arc === null ? null : WorkbenchGitArcLifecycleStateSchema.parse({
        ...base(arc), ...arcPaths(arc), proposals: proposals(arc.proposals),
        ...(arc.members?.length ? {
          members: arc.members.map((entry) => ({
            ...base(entry), ...member(entry), ...arcPaths(entry), proposals: proposals(entry.proposals),
          })),
        } : {}),
      });
    }
    if (value.gitArcPlan !== undefined) {
      const plan = value.gitArcPlan;
      result.gitArcPlan = plan === null ? null : WorkbenchGitArcPlanStateSchema.parse({
        ...base(plan), scopePaths: plan.scopePaths,
        ...(plan.members?.length ? {
          members: plan.members.map((entry) => ({ ...base(entry), ...member(entry), scopePaths: entry.scopePaths })),
        } : {}),
      });
    }
    return result;
  }

  replace(threadId: string, value: WorkbenchThreadGitObservations) {
    const { gitArc: arc, gitArcPlan: plan } = this.project(value);
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
    const paths = arc
      ? value.phase === "stashed" ? value.stashedPaths : value.claimedPaths
      : value.scopePaths;
    paths.forEach((path, pathIndex) => insertPath.run(id, pathIndex, path));
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

  private readMember(entry: GitEntry, batch: GitReadBatch) {
    const roots = batch.roots.get(entry.id) ?? [];
    this.requireOrdered(roots.map((root) => root.root_index));
    return {
      harness: entry.harness, threadId: entry.thread_id, repoRoot: entry.repo_root, rootId: entry.root_id,
      rootIds: roots.map((root) => root.root_id),
    };
  }

  private readArcPaths(entry: GitEntry, batch: GitReadBatch) {
    const paths = this.readPaths(entry.id, batch);
    return entry.phase === "stashed"
      ? { claimedPaths: [], phase: entry.phase, stashedPaths: paths }
      : { claimedPaths: paths, phase: entry.phase };
  }

  private readPaths(entryId: string, batch: GitReadBatch) {
    const paths = batch.paths.get(entryId) ?? [];
    this.requireOrdered(paths.map((path) => path.path_index));
    return paths.map((path) => path.path);
  }

  private readProposals(entryId: string, batch: GitReadBatch) {
    const proposals = batch.proposals.get(entryId) ?? [];
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

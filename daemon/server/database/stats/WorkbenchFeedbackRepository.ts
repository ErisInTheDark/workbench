/*
 * Exports:
 * - default WorkbenchFeedbackRepository: record, resolve, reopen, delete and expire agent feedback, and read importance-weighted stats summaries
 *   (open plus recently resolved), paged open agent reports, and one report by id as a stats section.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import { statsRangeShape } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  WORKBENCH_FEEDBACK_CATEGORIES,
  WORKBENCH_FEEDBACK_PAGE_SIZE,
  WORKBENCH_RESOLVED_FEEDBACK_RETENTION_MS,
  WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT,
  type WorkbenchFeedbackCategory,
  type WorkbenchFeedbackChannel,
  type WorkbenchFeedbackItem,
  type WorkbenchFeedbackReadRequest,
  type WorkbenchFeedbackReadResponse,
  type WorkbenchFeedbackRecord,
  type WorkbenchFeedbackSort,
  type WorkbenchStatsFeedback,
} from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { scoreFeedbackImportance } from "../../stats/feedback-importance.ts";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";

interface FeedbackFilter {
  category?: WorkbenchFeedbackCategory | null;
  channel?: WorkbenchFeedbackChannel | null;
  endedAt: number | null;
  projectIds: readonly string[] | null;
  /** Open reports, or reports resolved at or after `since`. */
  resolution: { kind: "open" } | { kind: "resolved"; since: number };
  startedAt: number;
  /** When set, wb reports are scoped by this owner instead of their filing project. */
  workbenchProjectId?: string | null;
}

interface ScoredRow {
  category: WorkbenchFeedbackCategory;
  channel: WorkbenchFeedbackChannel;
  createdAt: number;
  id: number;
  importance: number;
  resolvedAt: number | null;
  scored: boolean;
}

interface StoredScoreRow {
  category: WorkbenchFeedbackCategory; channel: WorkbenchFeedbackChannel; created_at: number;
  id: number; model: string | null; reasoning_effort: string | null; resolved_at: number | null;
}

const OPEN = { kind: "open" } as const;

function scoreRow(row: StoredScoreRow): ScoredRow {
  return {
    category: row.category,
    channel: row.channel,
    createdAt: row.created_at,
    id: row.id,
    resolvedAt: row.resolved_at,
    ...scoreFeedbackImportance({ category: row.category, model: row.model, reasoningEffort: row.reasoning_effort }),
  };
}

function ordered(rows: readonly ScoredRow[], sort: WorkbenchFeedbackSort) {
  return [...rows].sort((left, right) => (sort === "importance" ? right.importance - left.importance : 0)
    || right.createdAt - left.createdAt || right.id - left.id);
}

export default class WorkbenchFeedbackRepository {
  constructor(private readonly database: Database.Database) {}

  record(entry: WorkbenchFeedbackRecord, now: number) {
    return this.database.transaction(() => {
      const projectId = new WorkbenchProjectRepository(this.database).admitStoredReference(entry.projectId);
      this.database.prepare("INSERT INTO workbench_harnesses(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(entry.harness);
      const result = this.database.prepare(`
        INSERT INTO workbench_agent_feedback (
          project_id, thread_id, harness_id, model, reasoning_effort, channel, category, report, created_at, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, entry.threadId, entry.harness, entry.model, entry.reasoningEffort, entry.channel, entry.category, entry.report, now, entry.title);
      return { id: Number(result.lastInsertRowid) };
    })();
  }

  delete(ids: readonly number[]) {
    if (!ids.length) return 0;
    return this.database.prepare("DELETE FROM workbench_agent_feedback WHERE id IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(ids)).changes;
  }

  /** Resolving keeps an earlier resolution time; reopening clears it. Counts only reports whose state changed. */
  setResolved(ids: readonly number[], resolved: boolean, now: number) {
    if (!ids.length) return 0;
    return this.database.prepare(`
      UPDATE workbench_agent_feedback SET resolved_at = @resolvedAt
      WHERE id IN (SELECT value FROM json_each(@ids)) AND (resolved_at IS NULL) = @open
    `).run({ ids: JSON.stringify(ids), open: resolved ? 1 : 0, resolvedAt: resolved ? now : null }).changes;
  }

  /** Retention: resolved reports older than the resolved view's window are gone for good. */
  expireResolved(now: number) {
    return this.database.prepare("DELETE FROM workbench_agent_feedback WHERE resolved_at < ?")
      .run(now - WORKBENCH_RESOLVED_FEEDBACK_RETENTION_MS).changes;
  }

  /**
   * The stats view's section. Project reports stay with the project that filed them; wb reports are about
   * Workbench itself, so they belong to the Workbench project whichever project filed them. Open reports follow the
   * period; resolved ones follow their retention window instead, so a resolution never hides behind an old filing date.
   */
  summary(projectIds: readonly string[] | null, startedAt: number, endedAt: number, workbenchProjectId: string | null = null, now = Date.now()): WorkbenchStatsFeedback {
    const rows = this.#scored({ projectIds, resolution: OPEN, startedAt, endedAt, workbenchProjectId });
    const counts = WORKBENCH_FEEDBACK_CATEGORIES
      .map((category) => ({ category, count: rows.filter((row) => row.category === category).length }))
      .filter(({ count }) => count > 0);
    const items = ordered(rows, "importance").slice(0, WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT);
    const resolved = this.#scored({
      projectIds, resolution: { kind: "resolved", since: now - WORKBENCH_RESOLVED_FEEDBACK_RETENTION_MS },
      startedAt: 0, endedAt: null, workbenchProjectId,
    }).sort((left, right) => right.resolvedAt! - left.resolvedAt! || right.id - left.id).slice(0, WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT);
    const details = this.#details([...items, ...resolved]);
    return {
      counts,
      items: items.map((row) => details.get(row.id)!),
      ownership: this.#ownership({ projectIds, startedAt, endedAt }),
      resolved: resolved.map((row) => details.get(row.id)!),
      total: rows.length,
      workbenchProjectId: this.#workbenchOwner(workbenchProjectId),
    };
  }

  /** Agents read only open reports; resolved ones are already handled. */
  read(request: WorkbenchFeedbackReadRequest, now = Date.now()): WorkbenchFeedbackReadResponse {
    const rows = ordered(this.#scored({
      category: request.category,
      channel: request.channel,
      endedAt: null,
      projectIds: request.projectIds,
      resolution: OPEN,
      startedAt: request.range === "all" ? 0 : statsRangeShape(request.range, now).startedAt,
    }), request.sort);
    const pages = Math.max(1, Math.ceil(rows.length / WORKBENCH_FEEDBACK_PAGE_SIZE));
    const page = rows.slice((request.page - 1) * WORKBENCH_FEEDBACK_PAGE_SIZE, request.page * WORKBENCH_FEEDBACK_PAGE_SIZE);
    const details = this.#details(page);
    return { page: request.page, pages, rows: page.map((row) => details.get(row.id)!) };
  }

  /** The stats section narrowed to one report by id, whatever its scope, age or resolution; empty once deleted. */
  report(id: number, workbenchProjectId: string | null = null): WorkbenchStatsFeedback {
    const row = this.database.prepare(`
      SELECT id, channel, category, model, reasoning_effort, created_at, resolved_at FROM workbench_agent_feedback WHERE id = ?
    `).get(id) as StoredScoreRow | undefined;
    const item = row ? this.#details([scoreRow(row)]).get(id) : undefined;
    const owner = this.#workbenchOwner(workbenchProjectId);
    return item
      ? { counts: [{ category: item.category, count: 1 }], items: [item], ownership: [], resolved: [], total: 1, workbenchProjectId: owner }
      : { counts: [], items: [], ownership: [], resolved: [], total: 0, workbenchProjectId: owner };
  }

  #workbenchOwner(workbenchProjectId: string | null) {
    return workbenchProjectId ? new WorkbenchProjectRepository(this.database).resolveStoredReference(workbenchProjectId) : null;
  }

  /** Importance depends on the maintained trust registry, so it is computed on read rather than stored. */
  #scored(filter: FeedbackFilter): ScoredRow[] {
    const projects = new WorkbenchProjectRepository(this.database);
    const scope = filter.projectIds === null ? null : [...new Set(filter.projectIds.map((id) => projects.resolveStoredReference(id)))];
    const ownedByWorkbench = filter.workbenchProjectId !== undefined;
    const workbench = filter.workbenchProjectId ? projects.resolveStoredReference(filter.workbenchProjectId) : null;
    const rows = this.database.prepare(`
      SELECT id, channel, category, model, reasoning_effort, created_at, resolved_at
      FROM workbench_agent_feedback
      WHERE created_at >= @startedAt AND (@endedAt IS NULL OR created_at < @endedAt)
        AND (CASE WHEN @resolvedSince IS NULL THEN resolved_at IS NULL ELSE resolved_at >= @resolvedSince END)
        AND (
          CASE WHEN @ownedByWorkbench AND channel = 'wb'
            THEN @workbenchInScope
            ELSE @projects IS NULL OR project_id IN (SELECT value FROM json_each(@projects))
          END
        )
        AND (@channel IS NULL OR channel = @channel)
        AND (@category IS NULL OR category = @category)
    `).all({
      category: filter.category ?? null,
      channel: filter.channel ?? null,
      endedAt: filter.endedAt,
      ownedByWorkbench: ownedByWorkbench ? 1 : 0,
      projects: scope === null ? null : JSON.stringify(scope),
      resolvedSince: filter.resolution.kind === "resolved" ? filter.resolution.since : null,
      startedAt: filter.startedAt,
      workbenchInScope: workbench !== null && (scope === null || scope.includes(workbench)) ? 1 : 0,
    }) as StoredScoreRow[];
    return rows.map(scoreRow);
  }

  #details(rows: readonly ScoredRow[]) {
    const scored = new Map(rows.map((row) => [row.id, row]));
    const found = this.database.prepare(`
      SELECT f.id, f.project_id, f.thread_id, f.harness_id, f.model, f.reasoning_effort, f.report, f.title
      FROM workbench_agent_feedback f
      WHERE f.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify([...scored.keys()])) as Array<{
      harness_id: WorkbenchHarness; id: number; model: string | null; project_id: string; reasoning_effort: string | null;
      report: string; thread_id: string | null; title: string;
    }>;
    return new Map(found.map((row): [number, WorkbenchFeedbackItem] => {
      const score = scored.get(row.id)!;
      return [row.id, {
        category: score.category,
        channel: score.channel,
        createdAt: score.createdAt,
        harness: row.harness_id,
        id: row.id,
        importance: score.importance,
        model: row.model,
        owned: false,
        projectId: row.project_id,
        reasoningEffort: row.reasoning_effort,
        report: row.report,
        resolvedAt: score.resolvedAt,
        scored: score.scored,
        threadId: row.thread_id,
        title: row.title,
      }];
    }));
  }

  /** Attachments live with their owning threads and identify remote reports by source daemon plus id. */
  #ownership(filter: Pick<FeedbackFilter, "endedAt" | "projectIds" | "startedAt">): WorkbenchStatsFeedback["ownership"] {
    const projects = new WorkbenchProjectRepository(this.database);
    const scope = filter.projectIds === null ? null : [...new Set(filter.projectIds.map((id) => projects.resolveStoredReference(id)))];
    return this.database.prepare(`
      SELECT DISTINCT addressed.source_daemon_id AS daemonId, addressed.feedback_id AS id
      FROM workbench_thread_addressed_feedback addressed
      JOIN workbench_threads thread ON thread.id = addressed.thread_id
      WHERE addressed.created_at >= @startedAt
        AND (@endedAt IS NULL OR addressed.created_at < @endedAt)
        AND (@projects IS NULL OR thread.project_id IN (SELECT value FROM json_each(@projects)))
      ORDER BY addressed.source_daemon_id, addressed.feedback_id
    `).all({
      endedAt: filter.endedAt,
      projects: scope === null ? null : JSON.stringify(scope),
      startedAt: filter.startedAt,
    }) as WorkbenchStatsFeedback["ownership"];
  }
}

/*
 * Exports:
 * - default WorkbenchFeedbackRepository: record and delete agent feedback, and read importance-weighted stats summaries and paged agent reports.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import { statsRangeShape } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  WORKBENCH_FEEDBACK_CATEGORIES,
  WORKBENCH_FEEDBACK_PAGE_SIZE,
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
  scored: boolean;
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
          project_id, thread_id, harness_id, model, reasoning_effort, channel, category, report, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, entry.threadId, entry.harness, entry.model, entry.reasoningEffort, entry.channel, entry.category, entry.report, now);
      return { id: Number(result.lastInsertRowid) };
    })();
  }

  delete(ids: readonly number[]) {
    if (!ids.length) return 0;
    return this.database.prepare("DELETE FROM workbench_agent_feedback WHERE id IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(ids)).changes;
  }

  /**
   * The stats view's section. Project reports stay with the project that filed them; wb reports are about
   * Workbench itself, so they belong to the Workbench project whichever project filed them.
   */
  summary(projectIds: readonly string[] | null, startedAt: number, endedAt: number, workbenchProjectId: string | null = null): WorkbenchStatsFeedback {
    const rows = this.#scored({ projectIds, startedAt, endedAt, workbenchProjectId });
    const counts = WORKBENCH_FEEDBACK_CATEGORIES
      .map((category) => ({ category, count: rows.filter((row) => row.category === category).length }))
      .filter(({ count }) => count > 0);
    const items = ordered(rows, "importance").slice(0, WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT);
    const details = this.#details(items);
    return {
      counts, items: items.map((row) => details.get(row.id)!), total: rows.length,
      workbenchProjectId: workbenchProjectId ? new WorkbenchProjectRepository(this.database).resolveStoredReference(workbenchProjectId) : null,
    };
  }

  read(request: WorkbenchFeedbackReadRequest, now = Date.now()): WorkbenchFeedbackReadResponse {
    const rows = ordered(this.#scored({
      category: request.category,
      channel: request.channel,
      endedAt: null,
      projectIds: request.projectIds,
      startedAt: request.range === "all" ? 0 : statsRangeShape(request.range, now).startedAt,
    }), request.sort);
    const pages = Math.max(1, Math.ceil(rows.length / WORKBENCH_FEEDBACK_PAGE_SIZE));
    const page = rows.slice((request.page - 1) * WORKBENCH_FEEDBACK_PAGE_SIZE, request.page * WORKBENCH_FEEDBACK_PAGE_SIZE);
    const details = this.#details(page);
    return { page: request.page, pages, rows: page.map((row) => details.get(row.id)!) };
  }

  /** Importance depends on the maintained trust registry, so it is computed on read rather than stored. */
  #scored(filter: FeedbackFilter): ScoredRow[] {
    const projects = new WorkbenchProjectRepository(this.database);
    const scope = filter.projectIds === null ? null : [...new Set(filter.projectIds.map((id) => projects.resolveStoredReference(id)))];
    const ownedByWorkbench = filter.workbenchProjectId !== undefined;
    const workbench = filter.workbenchProjectId ? projects.resolveStoredReference(filter.workbenchProjectId) : null;
    const rows = this.database.prepare(`
      SELECT id, channel, category, model, reasoning_effort, created_at
      FROM workbench_agent_feedback
      WHERE created_at >= @startedAt AND (@endedAt IS NULL OR created_at < @endedAt)
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
      startedAt: filter.startedAt,
      workbenchInScope: workbench !== null && (scope === null || scope.includes(workbench)) ? 1 : 0,
    }) as Array<{
      category: WorkbenchFeedbackCategory; channel: WorkbenchFeedbackChannel; created_at: number;
      id: number; model: string | null; reasoning_effort: string | null;
    }>;
    return rows.map((row) => ({
      category: row.category,
      channel: row.channel,
      createdAt: row.created_at,
      id: row.id,
      ...scoreFeedbackImportance({ category: row.category, model: row.model, reasoningEffort: row.reasoning_effort }),
    }));
  }

  #details(rows: readonly ScoredRow[]) {
    const scored = new Map(rows.map((row) => [row.id, row]));
    const found = this.database.prepare(`
      SELECT f.id, f.project_id, f.thread_id, f.harness_id, f.model, f.reasoning_effort, f.report,
        COALESCE(NULLIF(s.title, ''), NULLIF(w.title, '')) title
      FROM workbench_agent_feedback f
      LEFT JOIN workbench_threads w ON w.id = f.thread_id
      LEFT JOIN workbench_thread_states s ON s.thread_id = w.id
      WHERE f.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify([...scored.keys()])) as Array<{
      harness_id: WorkbenchHarness; id: number; model: string | null; project_id: string; reasoning_effort: string | null;
      report: string; thread_id: string | null; title: string | null;
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
        projectId: row.project_id,
        reasoningEffort: row.reasoning_effort,
        report: row.report,
        scored: score.scored,
        threadId: row.thread_id,
        title: row.title ? row.title.slice(0, 500) : null,
      }];
    }));
  }
}

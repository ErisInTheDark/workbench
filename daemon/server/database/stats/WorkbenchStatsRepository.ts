/*
 * Exports:
 * - WorkbenchRateLimitObservation: typed durable rate-limit input.
 * - WorkbenchStoredStatsSection: stats sections SQLite answers (every section but daemon-owned status).
 * - default WorkbenchStatsRepository: own live claim/rate writes, claimed-root discovery, and one bounded SQLite section read at a time (usage, limits, claims, feedback, tools).
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  statsPeriodShape,
  statsRangeShape,
  type WorkbenchStatsReadRequest,
  type WorkbenchStatsResponse,
  type WorkbenchStatsSection,
  type WorkbenchStatsSectionData,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import { API_PRICING_CATALOG_DATE } from "../../stats/api-pricing.ts";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "../../stats/git-claim-observation.ts";
import WorkbenchUsageStatsRepository from "./WorkbenchUsageStatsRepository.ts";
import WorkbenchClaimStatsRepository, { type WorkbenchClaimedRoot } from "./WorkbenchClaimStatsRepository.ts";
import WorkbenchFeedbackRepository from "./WorkbenchFeedbackRepository.ts";
import WorkbenchToolStatsRepository from "./WorkbenchToolStatsRepository.ts";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";

export type WorkbenchStoredStatsSection = Exclude<WorkbenchStatsSection, "status">;

interface RateWindowObservation {
  durationMinutes: number | null;
  resetsAt: number | null;
  usedPercent: number;
}

export interface WorkbenchRateLimitObservation {
  harness: string;
  observedAt: number;
  snapshots: Array<{
    limitId: string;
    limitName: string | null;
    primary: RateWindowObservation | null;
    secondary: RateWindowObservation | null;
    tertiary?: RateWindowObservation | null;
  }>;
}

function boundedPercent(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function utcDayStart(value: number) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function sameWindow(left: RateWindowObservation | null, right: RateWindowObservation | null) {
  return left?.durationMinutes === right?.durationMinutes
    && left?.resetsAt === right?.resetsAt
    && left?.usedPercent === right?.usedPercent;
}

const MAX_RATE_LIMIT_SAMPLES = 2_000;

export default class WorkbenchStatsRepository {
  constructor(private readonly database: Database.Database) {}

  recordClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot) {
    const claimedDay = utcDayStart(snapshot.observedAt);
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO git_claim_thread_file_days (
        project_id, root_id, harness_id, thread_id, claimed_path, claimed_day
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      snapshot = { ...snapshot, projectId: new WorkbenchProjectRepository(this.database).admitStoredReference(snapshot.projectId) };
      this.database.prepare("INSERT INTO workbench_harnesses(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(snapshot.harness);
      for (const root of snapshot.roots) {
        for (const path of root.paths) {
          insert.run(snapshot.projectId, root.rootId, snapshot.harness, snapshot.threadId, path, claimedDay);
        }
      }
    })();
  }

  recordRateLimits(observation: WorkbenchRateLimitObservation) {
    this.database.transaction(() => {
      for (const snapshot of observation.snapshots) {
        const previousRows = this.database.prepare(`
          SELECT w.window_kind, w.used_basis_points, w.duration_minutes, w.resets_at
          FROM account_rate_limit_samples s
          LEFT JOIN account_rate_limit_windows w ON w.sample_id = s.id
          WHERE s.harness_id = ? AND s.limit_id = ?
            AND s.id = (SELECT id FROM account_rate_limit_samples WHERE harness_id = ? AND limit_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1)
        `).all(observation.harness, snapshot.limitId, observation.harness, snapshot.limitId) as Array<{
          duration_minutes: number | null; resets_at: number | null; used_basis_points: number | null;
          window_kind: "primary" | "secondary" | "tertiary" | null;
        }>;
        const previous = (kind: "primary" | "secondary" | "tertiary"): RateWindowObservation | null => {
          const row = previousRows.find((candidate) => candidate.window_kind === kind);
          return row?.used_basis_points === null || row?.used_basis_points === undefined ? null : {
            durationMinutes: row.duration_minutes,
            resetsAt: row.resets_at,
            usedPercent: row.used_basis_points / 100,
          };
        };
        const primary = snapshot.primary;
        const secondary = snapshot.secondary;
        const tertiary = snapshot.tertiary ?? null;
        if (previousRows.length && sameWindow(previous("primary"), primary)
          && sameWindow(previous("secondary"), secondary) && sameWindow(previous("tertiary"), tertiary)) continue;
        const result = this.database.prepare(`
          INSERT INTO account_rate_limit_samples (harness_id, limit_id, limit_name, observed_at)
          VALUES (?, ?, ?, ?)
        `).run(observation.harness, snapshot.limitId, snapshot.limitName, observation.observedAt);
        const insertWindow = this.database.prepare(`
          INSERT INTO account_rate_limit_windows (
            sample_id, window_kind, used_basis_points, duration_minutes, resets_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const [kind, window] of [["primary", primary], ["secondary", secondary], ["tertiary", tertiary]] as const) {
          if (window) insertWindow.run(Number(result.lastInsertRowid), kind, Math.round(boundedPercent(window.usedPercent) * 100), window.durationMinutes, window.resetsAt);
        }
      }
    })();
  }

  claimedRoots(projectIds: readonly string[] | null, range: WorkbenchStatsReadRequest["range"] | "all", now = Date.now()): WorkbenchClaimedRoot[] {
    const startedAt = range === "all" ? 0 : statsRangeShape(range, now).startedAt;
    return new WorkbenchClaimStatsRepository(this.database).claimedRoots(this.resolveProjects(projectIds), startedAt, now);
  }

  /** Status is daemon-owned (import progress and capture failures), so SQLite never reads it. */
  read<Section extends WorkbenchStoredStatsSection>(
    input: WorkbenchStatsReadRequest & { section: Section },
    now = Date.now(),
    renames: readonly WorkbenchGitClaimRename[] = [],
    workbenchProjectId: string | null = null,
  ): WorkbenchStatsSectionData<Section> {
    const request = { ...input, projectIds: this.resolveProjects(input.projectIds) };
    const period = statsPeriodShape(request.range, request.period ?? null, now);
    const read = (): WorkbenchStatsResponse => {
      switch (request.section) {
        case "usage": return {
          ...new WorkbenchUsageStatsRepository(this.database).read(request, now),
          generatedAt: now, pricingCatalogDate: API_PRICING_CATALOG_DATE, section: "usage",
        };
        case "limits": return { generatedAt: now, rateLimits: this.rateLimits(request.range, now), section: "limits" };
        case "claims": return {
          claimHotspots: new WorkbenchClaimStatsRepository(this.database)
            .hotspots(request.projectIds, period.startedAt, Math.min(now, period.endedAt - 1), renames),
          generatedAt: now, historyFailures: [], section: "claims",
        };
        // Provider and model filters describe usage, not feedback authors, so feedback follows only scope and period.
        case "feedback": return {
          feedback: new WorkbenchFeedbackRepository(this.database).summary(request.projectIds, period.startedAt, period.endedAt, workbenchProjectId),
          generatedAt: now, section: "feedback",
        };
        case "tools": return {
          generatedAt: now, section: "tools",
          tools: new WorkbenchToolStatsRepository(this.database).read(request.projectIds, period, now),
        };
      }
      throw new Error(`Stats section ${String(request.section)} is not stored in SQLite.`);
    };
    return read() as WorkbenchStatsSectionData<Section>;
  }

  /** Plan limits are account-wide and current, so they ignore scope and period and always span the whole range. */
  private rateLimits(range: WorkbenchStatsReadRequest["range"], now: number) {
    const limitsStartedAt = statsRangeShape(range, now).startedAt;
    const rateBucketMs = Math.max(1, Math.ceil((now - limitsStartedAt + 1) / (MAX_RATE_LIMIT_SAMPLES - 1)));

    const rateRows = this.database.prepare(`
      WITH candidates AS (
        SELECT * FROM account_rate_limit_samples WHERE observed_at BETWEEN ? AND ?
        UNION
        SELECT prior.* FROM account_rate_limit_samples prior
        WHERE prior.observed_at < ? AND prior.observed_at = (
          SELECT MAX(candidate.observed_at) FROM account_rate_limit_samples candidate
          WHERE candidate.harness_id = prior.harness_id AND candidate.limit_id = prior.limit_id
            AND candidate.observed_at < ?
        )
      ), ranked AS (
        SELECT id,
          COUNT(*) OVER (PARTITION BY harness_id, limit_id) sample_count,
          ROW_NUMBER() OVER (
            PARTITION BY harness_id, limit_id,
              CASE WHEN observed_at < ? THEN -1 ELSE CAST((observed_at - ?) / ? AS INTEGER) END
            ORDER BY observed_at DESC, id DESC
          ) sample_rank
        FROM candidates
      )
      SELECT s.*, w.window_kind, w.used_basis_points, w.duration_minutes, w.resets_at
      FROM account_rate_limit_samples s
      JOIN ranked r ON r.id = s.id AND (r.sample_count <= ? OR r.sample_rank = 1)
      LEFT JOIN account_rate_limit_windows w ON w.sample_id = s.id
      ORDER BY s.observed_at, s.id
    `).all(
      limitsStartedAt, now, limitsStartedAt, limitsStartedAt,
      limitsStartedAt, limitsStartedAt, rateBucketMs, MAX_RATE_LIMIT_SAMPLES,
    ) as Array<{
      duration_minutes: number | null; harness_id: WorkbenchHarness; id: number; limit_id: string;
      limit_name: string | null; observed_at: number; resets_at: number | null;
      used_basis_points: number | null; window_kind: "primary" | "secondary" | "tertiary" | null;
    }>;
    const rateSeries = new Map<string, WorkbenchStatsSectionData<"limits">["rateLimits"][number]>();
    for (const row of rateRows) {
      const key = `${row.harness_id}\0${row.limit_id}`;
      const series = rateSeries.get(key) ?? { harness: row.harness_id, limitId: row.limit_id, limitName: row.limit_name, samples: [] };
      if (!series.limitName && row.limit_name) series.limitName = row.limit_name;
      let sample = series.samples.find(({ observedAt }) => observedAt === row.observed_at);
      if (!sample) {
        sample = { observedAt: row.observed_at, primary: null, secondary: null, tertiary: null };
        series.samples.push(sample);
      }
      if (row.window_kind && row.used_basis_points !== null) {
        sample[row.window_kind] = {
          durationMinutes: row.duration_minutes,
          resetsAt: row.resets_at,
          usedPercent: row.used_basis_points / 100,
        };
      }
      rateSeries.set(key, series);
    }
    return [...rateSeries.values()];
  }

  private resolveProjects(projectIds: readonly string[] | null) {
    if (projectIds === null) return null;
    const projects = new WorkbenchProjectRepository(this.database);
    return [...new Set(projectIds.map((projectId) => projects.resolveStoredReference(projectId)))];
  }
}

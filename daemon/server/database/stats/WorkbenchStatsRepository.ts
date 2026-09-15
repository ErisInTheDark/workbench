/*
 * Exports:
 * - WorkbenchRateLimitObservation: typed durable rate-limit input.
 * - default WorkbenchStatsRepository: own live claim/rate writes and bounded SQLite aggregates.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  type WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  legacyStatsResponse,
  type WorkbenchStatsDetailedReadRequest,
  type WorkbenchStatsDetailedResponse,
} from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { API_PRICING_CATALOG_DATE } from "../../stats/api-pricing.ts";
import type { WorkbenchGitClaimRename, WorkbenchGitClaimSnapshot } from "../../stats/git-claim-observation.ts";
import WorkbenchUsageStatsRepository from "./WorkbenchUsageStatsRepository.ts";
import WorkbenchClaimStatsRepository from "./WorkbenchClaimStatsRepository.ts";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository.ts";

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
          window_kind: "primary" | "secondary" | null;
        }>;
        const previous = (kind: "primary" | "secondary"): RateWindowObservation | null => {
          const row = previousRows.find((candidate) => candidate.window_kind === kind);
          return row?.used_basis_points === null || row?.used_basis_points === undefined ? null : {
            durationMinutes: row.duration_minutes,
            resetsAt: row.resets_at,
            usedPercent: row.used_basis_points / 100,
          };
        };
        const primary = snapshot.primary;
        const secondary = snapshot.secondary;
        if (previousRows.length && sameWindow(previous("primary"), primary) && sameWindow(previous("secondary"), secondary)) continue;
        const result = this.database.prepare(`
          INSERT INTO account_rate_limit_samples (harness_id, limit_id, limit_name, observed_at)
          VALUES (?, ?, ?, ?)
        `).run(observation.harness, snapshot.limitId, snapshot.limitName, observation.observedAt);
        const insertWindow = this.database.prepare(`
          INSERT INTO account_rate_limit_windows (
            sample_id, window_kind, used_basis_points, duration_minutes, resets_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const [kind, window] of [["primary", primary], ["secondary", secondary]] as const) {
          if (window) insertWindow.run(Number(result.lastInsertRowid), kind, Math.round(boundedPercent(window.usedPercent) * 100), window.durationMinutes, window.resetsAt);
        }
      }
    })();
  }

  read(request: WorkbenchStatsDetailedReadRequest, now = Date.now(), renames: readonly WorkbenchGitClaimRename[] = []): WorkbenchStatsResponse {
    return legacyStatsResponse(this.readDetailed(request, now, renames));
  }

  readDetailed(request: WorkbenchStatsDetailedReadRequest, now = Date.now(), renames: readonly WorkbenchGitClaimRename[] = []): WorkbenchStatsDetailedResponse {
    if (request.projectId !== null) request = { ...request, projectId: new WorkbenchProjectRepository(this.database).resolveStoredReference(request.projectId) };
    const usage = new WorkbenchUsageStatsRepository(this.database).read(request, now);
    const claimHotspots = new WorkbenchClaimStatsRepository(this.database).hotspots(request.projectId, usage.startedAt, now, renames);

    const rateRows = this.database.prepare(`
      WITH selected AS (
        SELECT * FROM account_rate_limit_samples WHERE observed_at BETWEEN ? AND ?
        UNION
        SELECT prior.* FROM account_rate_limit_samples prior
        WHERE prior.observed_at < ? AND prior.observed_at = (
          SELECT MAX(candidate.observed_at) FROM account_rate_limit_samples candidate
          WHERE candidate.harness_id = prior.harness_id AND candidate.limit_id = prior.limit_id
            AND candidate.observed_at < ?
        )
      )
      SELECT s.*, w.window_kind, w.used_basis_points, w.duration_minutes, w.resets_at
      FROM selected s LEFT JOIN account_rate_limit_windows w ON w.sample_id = s.id
      ORDER BY s.observed_at, s.id
    `).all(usage.startedAt, now, usage.startedAt, usage.startedAt) as Array<{
      duration_minutes: number | null; harness_id: WorkbenchHarness; id: number; limit_id: string;
      limit_name: string | null; observed_at: number; resets_at: number | null;
      used_basis_points: number | null; window_kind: "primary" | "secondary" | null;
    }>;
    const rateSeries = new Map<string, WorkbenchStatsResponse["rateLimits"][number]>();
    for (const row of rateRows) {
      const key = `${row.harness_id}\0${row.limit_id}`;
      const series = rateSeries.get(key) ?? { harness: row.harness_id, limitId: row.limit_id, limitName: row.limit_name, samples: [] };
      if (!series.limitName && row.limit_name) series.limitName = row.limit_name;
      let sample = series.samples.find(({ observedAt }) => observedAt === row.observed_at);
      if (!sample) {
        sample = { observedAt: row.observed_at, primary: null, secondary: null };
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

    return {
      ...usage,
      claimHotspots,
      failures: [],
      generatedAt: now,
      historyImport: EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
      pricingCatalogDate: API_PRICING_CATALOG_DATE,
      projectId: request.projectId,
      rateLimits: [...rateSeries.values()],
      range: request.range,
      version: 2,
    };
  }
}

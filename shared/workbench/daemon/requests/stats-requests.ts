/*
 * Exports:
 * - statsDaemonRequests: daemon requests for history imports, rate-limit refresh, and agent feedback deletion and resolution.
 */
import { z } from "zod";
import { WorkbenchStatsImportProgressSchema, type WorkbenchStatsImportProgress } from "../../stats/workbench-stats-contract.ts";
import { defineDaemonRequest } from "../define-daemon-request.ts";

export const statsDaemonRequests = {
  "stats/import/start": defineDaemonRequest<object, WorkbenchStatsImportProgress>()({
    route: "installation", result: WorkbenchStatsImportProgressSchema,
  }),
  "stats/rate-limits/refresh": defineDaemonRequest<object, { ok: true }>()({
    route: "installation", result: z.object({ ok: z.literal(true) }).strict(),
  }),
  "stats/feedback/delete": defineDaemonRequest<{ ids: number[] }, { deleted: number }>()({
    route: "installation", result: z.object({ deleted: z.number().int().nonnegative() }).strict(),
  }),
  "stats/feedback/resolve": defineDaemonRequest<{ ids: number[]; resolved: boolean }, { changed: number }>()({
    route: "installation", result: z.object({ changed: z.number().int().nonnegative() }).strict(),
  }),
};

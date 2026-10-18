/*
 * Exports:
 * - statsRequestHandlers: daemon handlers for history imports, rate-limit refresh, and agent feedback deletion and resolution.
 */
import { z } from "zod";
import { WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
import { defineDaemonRequestHandlers, InvalidParamsError } from "./daemon-request-handler";

const feedbackIds = z.array(z.number().int().positive()).min(1).max(WORKBENCH_STATS_FEEDBACK_ITEM_LIMIT);

export const statsRequestHandlers = defineDaemonRequestHandlers({
  "stats/import/start": async (params, { owners }) => {
    if (Object.keys(params).length) throw new InvalidParamsError("Stats import start does not accept parameters.");
    return await owners.stats.startImport();
  },
  "stats/rate-limits/refresh": async (_params, { owners }) => {
    await owners.stats.refreshRateLimits();
    return { ok: true };
  },
  "stats/feedback/delete": async (params, { owners }) => {
    const ids = z.object({ ids: feedbackIds }).strict().safeParse(params);
    if (!ids.success) throw new InvalidParamsError("Feedback deletion needs between 1 and 200 feedback ids.");
    return { deleted: await owners.stats.deleteFeedback(ids.data.ids) };
  },
  "stats/feedback/resolve": async (params, { owners }) => {
    const input = z.object({ ids: feedbackIds, resolved: z.boolean() }).strict().safeParse(params);
    if (!input.success) throw new InvalidParamsError("Feedback resolution needs between 1 and 200 feedback ids and a resolved flag.");
    return { changed: await owners.stats.resolveFeedback(input.data.ids, input.data.resolved) };
  },
});

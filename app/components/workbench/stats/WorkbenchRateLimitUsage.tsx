/*
 * Exports:
 * - default WorkbenchRateLimitUsage: render one graph per real account limit with only observed windows. Keywords: stats, rate limit, graph.
 * Local helpers: read quota windows from the current sample. Keywords: rate limit, sample.
 */
import type { WorkbenchStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  formatRateLimitIdentity,
  formatRateLimitResetTime,
  formatRateLimitWindowLabel,
} from "../../../workbench/rate-limit-display";
import WorkbenchStatsChart from "./WorkbenchStatsChart";

type Limit = WorkbenchStatsResponse["rateLimits"][number];
type WindowKind = "primary" | "secondary";

function currentWindow(limit: Limit, kind: WindowKind) {
  return limit.samples.at(-1)?.[kind] ?? null;
}

export default function WorkbenchRateLimitUsage({ stats }: {
  stats: Pick<WorkbenchStatsResponse, "rateLimits"> | null;
}) {
  return (
    <section aria-labelledby="rate-limit-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="rate-limit-heading">Rate limits</h2>
        <span className="text-[0.72rem] text-fg/muted">account-wide</span>
      </div>
      <div>
      {stats?.rateLimits.length ? (
        <div className="grid gap-8 lg:grid-cols-2">
          {stats.rateLimits.map((limit) => {
            const primary = currentWindow(limit, "primary");
            const secondary = currentWindow(limit, "secondary");
            const windows: Array<{
              colour: string;
              kind: WindowKind;
              window: NonNullable<ReturnType<typeof currentWindow>>;
            }> = [];
            if (primary) windows.push({ colour: "var(--accent)", kind: "primary", window: primary });
            if (secondary) windows.push({ colour: "var(--text)", kind: "secondary", window: secondary });
            return (
              <div className="min-w-0 space-y-3" key={`${limit.harness}:${limit.limitId}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="m-0 text-[0.82rem] font-semibold text-text">
                    {formatRateLimitIdentity(limit.harness, limit.limitId, limit.limitName)}
                  </h3>
                  <span className="flex flex-wrap gap-x-3 text-[0.72rem] text-fg/muted">
                    {windows.map(({ kind, window }) => (
                      <span key={kind}>
                        {formatRateLimitWindowLabel(window.durationMinutes, kind === "primary" ? "Primary" : "Secondary")}
                        {" · "}{window.usedPercent.toFixed(1)}% used
                        {" · "}{formatRateLimitResetTime(window.resetsAt)}
                      </span>
                    ))}
                  </span>
                </div>
                <WorkbenchStatsChart
                  buckets={limit.samples.map(({ observedAt }) => observedAt)}
                  formatValue={(value) => `${value.toFixed(1)}%`}
                  series={windows.map(({ colour, kind, window }) => ({
                    colour,
                    label: formatRateLimitWindowLabel(window.durationMinutes, kind === "primary" ? "Primary" : "Secondary"),
                    values: limit.samples.map((sample) => sample[kind]?.usedPercent ?? null),
                  }))}
                  title="Consumed"
                />
              </div>
            );
          })}
        </div>
      ) : <p className="m-0 text-[0.8rem] text-fg/muted">{stats ? "No rate-limit history is available yet." : "-"}</p>}
      </div>
    </section>
  );
}

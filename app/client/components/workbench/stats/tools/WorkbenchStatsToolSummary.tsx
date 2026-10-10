/*
 * Exports:
 * - default WorkbenchStatsToolSummary: headline wb tool calls, always-on tool prompt cost, tool tokens an average thread carries unused, and tools never called in the range.
 */
import type { ReactNode } from "react";
import useStats from "../use-stats";
import Skeleton, { statsReloadingClassName, statsRevealClassName } from "../../../ui/Skeleton";
import Sparkline from "../../../ui/Sparkline";
import { compactNumber } from "../stats-formatters";
import { summariseStatsTools } from "workbench-shared/workbench/stats/workbench-stats-tool-value";

function Card({ children, detail, label, primary = false, trend }: {
  children: ReactNode | null;
  detail?: ReactNode;
  label: string;
  primary?: boolean;
  trend?: readonly number[];
}) {
  return (
    <div className={`relative min-w-0 overflow-hidden rounded-lg px-3 pb-3 pt-2.5 ${primary ? "col-span-2 sm:col-span-1" : ""}`}>
      {trend ? <Sparkline className="text-hue-170" values={trend} /> : null}
      <dt className="relative text-[0.72rem] font-medium text-fg/muted">{label}</dt>
      {children === null ? (
        <>
          <dd className={`m-0 mt-0.5 flex items-center ${primary ? "h-[2.375rem]" : "h-[1.856rem]"}`}>
            <Skeleton className={primary ? "h-7 w-24" : "h-5 w-16"} />
          </dd>
          <dd className="m-0 flex h-[1.05rem] items-center"><Skeleton className="h-2.5 w-24" /></dd>
        </>
      ) : (
        <>
          <dd className={`relative m-0 mt-0.5 truncate font-semibold tabular-nums text-text ${primary ? "text-[1.9rem] leading-tight" : "text-[1.35rem] leading-snug"} ${statsRevealClassName}`}>
            {children}
          </dd>
          <dd className={`relative m-0 truncate text-[0.7rem] tabular-nums text-fg/muted ${statsRevealClassName}`}>{detail ?? " "}</dd>
        </>
      )}
    </div>
  );
}

export default function WorkbenchStatsToolSummary() {
  const { data, loading } = useStats.tools();
  const tools = data?.tools ?? null;
  const summary = tools ? summariseStatsTools(tools) : null;
  const catalogue = tools?.catalogue ?? null;
  return (
    <dl aria-busy={loading} className={`m-0 grid grid-cols-2 gap-3 lg:grid-cols-4 [--hue-chroma:55%] ${statsReloadingClassName(loading && Boolean(data))}`}>
      <Card detail={summary ? `${compactNumber(tools!.workbench.filter(({ calls }) => calls).length)} tools used` : undefined} label="wb tool calls" primary trend={summary?.buckets}>
        {summary ? compactNumber(summary.calls) : null}
      </Card>
      <Card
        detail={catalogue ? <><span className="text-hue-210">{compactNumber(Math.round(catalogue.specTokens))} spec</span> · <span className="text-hue-300">{compactNumber(Math.round(catalogue.docsTokens))} docs</span></> : tools ? "catalogue unavailable" : undefined}
        label="Always-on prompt cost"
      >
        {tools ? catalogue ? <>≈{compactNumber(Math.round(catalogue.specTokens + catalogue.docsTokens))}<span className="ml-1 text-[0.8rem] font-medium text-fg/muted">tokens</span></> : "-" : null}
      </Card>
      <Card
        detail={summary ? summary.wastePerThread === null || !catalogue ? "no tool calls yet"
          : `${Math.round(summary.wastePerThread / (catalogue.specTokens + catalogue.docsTokens) * 100)}% of tool prompt, unused` : undefined}
        label="Tool waste per thread"
      >
        {summary ? summary.wastePerThread === null ? "-" : (
          <span title="Each tool's prompt cost times the share of active threads that never called it">
            ≈{compactNumber(Math.round(summary.wastePerThread))}<span className="ml-1 text-[0.8rem] font-medium text-fg/muted">tokens</span>
          </span>
        ) : null}
      </Card>
      <Card detail={summary ? `of ${summary.catalogued} tools, in this range` : undefined} label="Never called">
        {summary ? <span className={summary.idle ? "text-hue-40 [--hue-chroma:60%]" : ""}>{summary.idle}</span> : null}
      </Card>
    </dl>
  );
}

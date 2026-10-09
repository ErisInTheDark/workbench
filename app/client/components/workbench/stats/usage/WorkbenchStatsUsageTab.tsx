/*
 * Exports:
 * - default WorkbenchStatsUsageTab: provider, model, cost and token usage; each panel streams in on its own.
 */
import WorkbenchCacheEfficiency from "./WorkbenchCacheEfficiency";
import WorkbenchStatsActivity from "./WorkbenchStatsActivity";
import WorkbenchStatsBreakdowns from "./WorkbenchStatsBreakdowns";
import WorkbenchStatsHeadline from "./WorkbenchStatsHeadline";
import WorkbenchStatsLimits from "./WorkbenchStatsLimits";

export default function WorkbenchStatsUsageTab() {
  return (
    <div className="flex flex-col gap-7">
      <WorkbenchStatsLimits />
      <WorkbenchStatsHeadline />
      <div className="pt-3"><WorkbenchStatsActivity /></div>
      <div className="flex flex-col gap-10 pt-3">
        <WorkbenchStatsBreakdowns />
        <WorkbenchCacheEfficiency />
      </div>
    </div>
  );
}

/*
 * Exports:
 * - default WorkbenchStatsUsageTab: provider, model, cost and token usage; each panel streams in on its own. Plan limits lead the
 *   view above the shared controls, since the controls do not narrow them.
 */
import WorkbenchCacheEfficiency from "./WorkbenchCacheEfficiency";
import WorkbenchStatsActivity from "./WorkbenchStatsActivity";
import WorkbenchStatsBreakdowns from "./WorkbenchStatsBreakdowns";
import WorkbenchStatsHeadline from "./WorkbenchStatsHeadline";

export default function WorkbenchStatsUsageTab() {
  return (
    <div className="flex flex-col gap-7">
      <WorkbenchStatsHeadline />
      <div className="pt-3"><WorkbenchStatsActivity /></div>
      <div className="flex flex-col gap-10 pt-3">
        <WorkbenchStatsBreakdowns />
        <WorkbenchCacheEfficiency />
      </div>
    </div>
  );
}

/*
 * Exports:
 * - default WorkbenchStatsToolsTab: whether each wb tool earns the prompt tokens it adds to every turn.
 */
import WorkbenchStatsToolSummary from "./WorkbenchStatsToolSummary";
import WorkbenchStatsToolValue from "./WorkbenchStatsToolValue";

export default function WorkbenchStatsToolsTab() {
  return (
    <div className="flex flex-col gap-10">
      <WorkbenchStatsToolSummary />
      <WorkbenchStatsToolValue />
    </div>
  );
}

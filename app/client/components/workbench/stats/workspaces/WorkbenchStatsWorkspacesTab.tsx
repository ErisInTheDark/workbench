/*
 * Exports:
 * - default WorkbenchStatsWorkspacesTab: how agents share the workspace: contended files and their friction reports.
 */
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots";
import WorkbenchStatsFeedback from "./WorkbenchStatsFeedback";

export default function WorkbenchStatsWorkspacesTab() {
  return (
    <div className="flex flex-col gap-10 pt-1">
      <WorkbenchClaimHotspots />
      <WorkbenchStatsFeedback />
    </div>
  );
}

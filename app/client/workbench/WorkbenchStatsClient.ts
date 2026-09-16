/*
 * Exports:
 * - default WorkbenchStatsClient: adapt detailed reads and explicit legacy-server responses.
 */
import type { WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

const PREVIOUS_STATS_PROTOCOL = {
  efficiencyV2: "efficiency",
  efficiency: "detailed",
  detailed: "read",
} as const;

export default class WorkbenchStatsClient {
  private protocol: keyof typeof PREVIOUS_STATS_PROTOCOL | "read" = "efficiencyV2";
  constructor(private readonly daemon: Pick<WorkbenchDaemonClient, "stats">) {}

  reconnected() { this.protocol = "efficiencyV2"; }

  async read(request: WorkbenchStatsDetailedReadRequest) {
    while (this.protocol !== "read") {
      try {
        return await this.daemon.stats[this.protocol](request);
      } catch (error) {
        if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== -32601) throw error;
        this.protocol = PREVIOUS_STATS_PROTOCOL[this.protocol];
      }
    }
    const { tokenTypes: _selection, ...legacyRequest } = request;
    return await this.daemon.stats.read(legacyRequest);
  }
}

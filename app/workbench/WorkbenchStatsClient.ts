/*
 * Keywords: stats, protocol, compatibility, category costs, input cache.
 * Exports:
 * - default WorkbenchStatsClient: adapt detailed reads and explicit legacy-server responses.
 */
import type { WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

const PREVIOUS_STATS_PROTOCOL = {
  "stats/read/efficiency/v2": "stats/read/efficiency",
  "stats/read/efficiency": "stats/read/detailed",
  "stats/read/detailed": "stats/read",
} as const;

export default class WorkbenchStatsClient {
  private protocol: keyof typeof PREVIOUS_STATS_PROTOCOL | "stats/read" = "stats/read/efficiency/v2";
  constructor(private readonly daemon: Pick<WorkbenchDaemonClient, "request">) {}

  reconnected() { this.protocol = "stats/read/efficiency/v2"; }

  async read(request: WorkbenchStatsDetailedReadRequest) {
    while (this.protocol !== "stats/read") {
      try {
        return await this.daemon.request(this.protocol, request);
      } catch (error) {
        if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== -32601) throw error;
        this.protocol = PREVIOUS_STATS_PROTOCOL[this.protocol];
      }
    }
    const { tokenTypes: _selection, ...legacyRequest } = request;
    return await this.daemon.request("stats/read", legacyRequest);
  }
}

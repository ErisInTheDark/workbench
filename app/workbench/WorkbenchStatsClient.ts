/*
 * Keywords: stats, protocol, compatibility, category costs.
 * Exports:
 * - default WorkbenchStatsClient: adapt detailed reads and explicit legacy-server responses.
 */
import type { WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchDaemonClient, { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

export default class WorkbenchStatsClient {
  private legacy = false;
  constructor(private readonly daemon: Pick<WorkbenchDaemonClient, "request">) {}

  reconnected() { this.legacy = false; }

  async read(request: WorkbenchStatsDetailedReadRequest) {
    if (!this.legacy) {
      try {
        return await this.daemon.request("stats/read/detailed", request);
      } catch (error) {
        if (!(error instanceof WorkbenchDaemonRequestError) || error.code !== -32601) throw error;
        this.legacy = true;
      }
    }
    const { tokenTypes: _selection, ...legacyRequest } = request;
    return await this.daemon.request("stats/read", legacyRequest);
  }
}

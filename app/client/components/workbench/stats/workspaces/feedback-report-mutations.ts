/*
 * Exports:
 * - deleteFeedbackReports: delete feedback reports on the machines storing them.
 * - setFeedbackReportsResolved: resolve or reopen feedback reports on the machines storing them.
 * Both reject reports from unknown machines.
 */
import { DaemonIdSchema, type DaemonId } from "workbench-shared/workbench/identity";
import type WorkbenchWorkspaceClient from "../../../../workbench/app/WorkbenchWorkspaceClient";

type StoredReport = { daemonId: string | null | undefined; id: number };

async function perMachine(
  workspace: WorkbenchWorkspaceClient,
  reports: readonly StoredReport[],
  action: string,
  run: (daemon: ReturnType<WorkbenchWorkspaceClient["daemon"]>, ids: number[]) => Promise<unknown>,
) {
  await Promise.all([...Map.groupBy(reports, ({ daemonId }) => daemonId)].map(([daemonId, owned]) => {
    const daemon: DaemonId | undefined = DaemonIdSchema.safeParse(daemonId).data;
    if (!daemon) throw new Error(`Feedback from an unknown machine cannot be ${action}.`);
    return run(workspace.daemon({ kind: "installation", daemonId: daemon }), owned.map(({ id }) => id));
  }));
}

export async function deleteFeedbackReports(workspace: WorkbenchWorkspaceClient, reports: readonly StoredReport[]) {
  await perMachine(workspace, reports, "deleted", (daemon, ids) => daemon.stats.deleteFeedback(ids));
}

export async function setFeedbackReportsResolved(workspace: WorkbenchWorkspaceClient, reports: readonly StoredReport[], resolved: boolean) {
  await perMachine(workspace, reports, resolved ? "resolved" : "reopened", (daemon, ids) => daemon.stats.resolveFeedback(ids, resolved));
}

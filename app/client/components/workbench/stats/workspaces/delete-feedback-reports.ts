/*
 * Exports:
 * - default deleteFeedbackReports: delete feedback reports on the machines storing them, rejecting reports from unknown machines.
 */
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchWorkspaceClient from "../../../../workbench/app/WorkbenchWorkspaceClient";

export default async function deleteFeedbackReports(
  workspace: WorkbenchWorkspaceClient,
  reports: readonly { daemonId: string | null | undefined; id: number }[],
) {
  await Promise.all([...Map.groupBy(reports, ({ daemonId }) => daemonId)].map(([daemonId, owned]) => {
    const daemon = DaemonIdSchema.safeParse(daemonId).data;
    if (!daemon) throw new Error("Feedback from an unknown machine cannot be deleted.");
    return workspace.daemon({ kind: "installation", daemonId: daemon }).stats.deleteFeedback(owned.map(({ id }) => id));
  }));
}

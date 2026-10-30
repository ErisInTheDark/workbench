/*
 * Default export:
 * - WorkbenchAgentNetworkGrantSettings: every reachable daemon's inbound agent network grants, which threads on other daemons may
 *   reach there, each revocable.
 */
"use client";
import { useCallback, useEffect, useState } from "react";
import type { DaemonId } from "workbench-shared/workbench/identity";
import type { NetworkGrant } from "workbench-shared/workbench/network/network-grants";
import type { WorkspaceNetworkGrantsList } from "workbench-shared/workbench/workspace/workspace-commands";
import { useWorkbenchClientController } from "./workbench-client-context";
import WorkbenchRelativeTime from "./WorkbenchRelativeTime";

const KIND_LABELS: Record<NetworkGrant["kind"], string> = {
  thread: "Message and read", message: "Reply to", folder: "Create subagents in", feedback: "Read feedback",
};

export default function WorkbenchAgentNetworkGrantSettings() {
  const workspace = useWorkbenchClientController().mounted?.workspace ?? null;
  const [list, setList] = useState<WorkspaceNetworkGrantsList | null>(null);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setList(await workspace.listNetworkGrants());
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Agent access could not be read."); }
  }, [workspace]);
  useEffect(() => { void load(); }, [load]);
  const revoke = async (daemonId: DaemonId, grant: NetworkGrant) => {
    if (!workspace) return;
    setRevoking(grant.id);
    try {
      await workspace.revokeNetworkGrants({ kind: "revoke", daemonId, grantIds: [grant.id] });
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The grant could not be revoked."); }
    finally { setRevoking(null); }
  };
  const daemons = list?.daemons.filter(daemon => daemon.grants.length || daemon.failure) ?? [];
  return <div className="flex flex-col gap-3 py-2">
    <p className="m-0 text-sm text-fg/muted">Threads on other daemons you let reach each daemon. Each daemon enforces its own list.</p>
    {list && !daemons.length ? <p className="m-0 text-sm text-fg/muted">No agent network access granted.</p> : null}
    {daemons.map(daemon => <div className="flex flex-col gap-1.5" key={daemon.daemonId}>
      <span className="text-sm font-medium text-text">{daemon.hostname}</span>
      {daemon.failure ? <p role="alert" className="m-0 text-sm text-danger">{daemon.failure}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {daemon.grants.map(grant => <li className="flex min-w-0 items-center gap-2 text-sm" key={grant.id}>
          <span className="min-w-0 flex-1 truncate text-text" title={`${grant.callerTitle} (${grant.callerThreadId})`}>
            {grant.callerTitle} <span className="text-fg/muted">on {grant.callerHostname}</span>
          </span>
          <span className="min-w-0 max-w-[40%] truncate text-fg/muted" title={grant.targetLabel}>{KIND_LABELS[grant.kind]} {grant.targetLabel}</span>
          <WorkbenchRelativeTime format="short" timestampMs={grant.createdAt} tooltip={false} />
          <button
            className="shrink-0 rounded-md px-2 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={revoking !== null}
            onClick={() => { void revoke(daemon.daemonId, grant); }}
            type="button"
          >{revoking === grant.id ? "Revoking..." : "Revoke"}</button>
        </li>)}
      </ul>
    </div>)}
    {error ? <p role="alert" className="m-0 text-sm text-danger">{error}</p> : null}
  </div>;
}

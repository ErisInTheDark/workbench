/* Exports: default WorkbenchGitPeerTransferButton: Pull/Send with one peer device's folder, previewing its commits on hover. */
"use client";

import type { GitPeerAddress } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import WorkbenchGitPeerTooltip from "./WorkbenchGitPeerTooltip";
import WorkbenchGitSyncButton from "./WorkbenchGitSyncButton";

export default function WorkbenchGitPeerTransferButton({ location, peer: address, action, showCount = false, className }: {
  location: ProjectLocationReference;
  peer: GitPeerAddress;
  action: "pull" | "send";
  showCount?: boolean;
  className?: string;
}) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const peer = snapshot.data?.peers.find(item => item.daemonId === address.daemonId && item.projectId === address.projectId);
  const busy = snapshot.busy?.peerKey === `${address.daemonId}/${address.projectId}` && snapshot.busy.action === action
    ? snapshot.busy.mode : null;
  const current = peer?.state === "current" ? peer : null;
  const fastForward = Boolean(current && (action === "pull"
    ? current.ahead === 0 && current.behind > 0
    : current.behind === 0 && current.ahead > 0));
  const count = peer ? action === "pull" ? peer.behind : peer.ahead : 0;
  return <WorkbenchGitSyncButton
    location={location} verb={action === "pull" ? "Pull" : "Send"} className={className}
    fastForward={fastForward} busyMode={busy} disabled={!state || !current || snapshot.busy !== null}
    menuId={`git-peer-${action}-${address.daemonId}-${address.projectId}`}
    count={showCount ? count : null}
    onTransfer={mode => { if (state && current) void state.transfer(action, current, mode); }}
    tooltip={(mode, unavailable) => <WorkbenchGitPeerTooltip
      key={`${location.daemonId}/${location.projectId}/${address.daemonId}/${address.projectId}/${snapshot.data?.branch}/${action}`}
      location={location} peer={address} hostname={peer?.hostname ?? "peer"} branch={snapshot.data?.branch ?? null}
      action={action} mode={mode} unavailable={unavailable ?? (!current ? "Device unavailable" : null)} />}
  />;
}

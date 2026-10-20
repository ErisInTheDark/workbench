/* Exports: default WorkbenchGitPeerTransferButton: shared preference-aware Pull/Send control with Shift and explicit mode selection. */
"use client";

import type { MouseEvent } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { GitPeerAddress, GitPeerSyncMode, GitPeerTransfer } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { useSettings } from "../use-settings";
import { useWorkbenchClientState } from "../workbench-client-state-context";
import { GitFastForwardIcon, GitMergeIcon, GitRebaseIcon } from "../workbench-icons";
import WorkbenchGitPeerTooltip from "./WorkbenchGitPeerTooltip";

export default function WorkbenchGitPeerTransferButton({ location, peer: address, action, showCount = false, showHostname = false, className }: {
  location: ProjectLocationReference;
  peer: GitPeerAddress;
  action: "pull" | "send";
  showCount?: boolean;
  showHostname?: boolean;
  className?: string;
}) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  // The folder's project may override the sync mode; until the project is known the setting is unavailable.
  const settings = useSettings.forLocation(location);
  const schemaReady = useWorkbenchClientState(state => state.schemaVersion >= appStateReleases.gitPeerSyncMode.version);
  const menu = useWorkbenchContextMenu();
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const peer = snapshot.data?.peers.find(item => item.daemonId === address.daemonId && item.projectId === address.projectId);
  const defaultMode = settings.get("gitPeerSyncMode");
  const alternate: GitPeerSyncMode = defaultMode === "merge" ? "rebase" : "merge";
  const busy = snapshot.busy?.peerKey === `${address.daemonId}/${address.projectId}` && snapshot.busy.action === action;
  const fastForward = peer?.state === "current" && (action === "pull"
    ? peer.ahead === 0 && peer.behind > 0
    : peer.behind === 0 && peer.ahead > 0);
  const selected = busy ? snapshot.busy!.mode : fastForward ? "fastForward" : shift ? alternate : defaultMode;
  const available = !settings.unavailable("gitPeerSyncMode");
  const disabled = !available || !state || !peer || peer.state !== "current" || snapshot.busy !== null;
  const verb = action === "pull" ? "Pull" : "Send";
  const count = peer ? action === "pull" ? peer.behind : peer.ahead : 0;
  const Icon = selected === "fastForward" ? GitFastForwardIcon : selected === "merge" ? GitMergeIcon : GitRebaseIcon;
  const transfer = (mode: GitPeerTransfer["mode"]) => {
    if (!disabled && state && peer) void state.transfer(action, peer, mode);
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (disabled || fastForward) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    menu.openContextMenu({ x: bounds.left, y: bounds.bottom, menu: {
      id: `git-peer-${action}-${address.daemonId}-${address.projectId}`,
      label: `${verb} mode`,
      items: (["merge", "rebase"] as const).map(mode => ({
        id: mode, label: `${verb} with ${mode}`, onSelect: () => transfer(mode),
      })),
    } });
  };
  return <Tooltip placement="top" interactive content={<WorkbenchGitPeerTooltip
    key={`${location.daemonId}/${location.projectId}/${address.daemonId}/${address.projectId}/${snapshot.data?.branch}/${action}`}
    location={location} peer={address} hostname={peer?.hostname ?? "peer"} branch={snapshot.data?.branch ?? null}
    action={action} mode={selected} unavailable={!available
      ? !schemaReady ? "App database reload needed" : "Loading project"
      : peer?.state !== "current" ? "Device unavailable" : null}
  />}>
      <span className="inline-flex shrink-0">
        <PrimaryButton shape="compact" className={className} disabled={disabled} pendingHalo={busy}
          onContextMenu={openMenu}
          onClick={event => transfer(fastForward ? "fastForward" : event.shiftKey ? alternate : defaultMode)}>
          <Icon size={14} className="mr-1.5 shrink-0" />
          {verb}{showCount ? ` ${count}` : ""}{selected !== "fastForward" ? ` · ${selected}` : ""}{showHostname && peer ? ` · ${peer.hostname}` : ""}
        </PrimaryButton>
      </span>
    </Tooltip>;
}

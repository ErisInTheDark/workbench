/* Exports: default WorkbenchGitPeerTransferButton: shared preference-aware Pull/Send control with Shift and explicit mode selection. */
"use client";

import { useSyncExternalStore, type MouseEvent } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { GitPeerAddress, GitPeerSyncMode } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useGitPeerState } from "../../../workbench/git/WorkbenchGitPeerState";
import { readGlobalWorkbenchSettings, readLogicalProjectWorkbenchSettings, resolveWorkbenchSettings } from "../../../workbench/state/workbench-settings";
import IconButton from "../../ui/IconButton";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { useWorkbenchClientController } from "../workbench-client-context";
import { useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { MoreVerticalIcon } from "../workbench-icons";

const unsubscribe = () => () => undefined;

export default function WorkbenchGitPeerTransferButton({ location, peer: address, action, showCount = false, showHostname = false, className }: {
  location: ProjectLocationReference;
  peer: GitPeerAddress;
  action: "pull" | "send";
  showCount?: boolean;
  showHostname?: boolean;
  className?: string;
}) {
  const { state, snapshot } = useGitPeerState(useWorkbenchWorkspace(), location);
  const client = useWorkbenchClientController();
  const preferences = useWorkbenchClientStateSnapshot();
  const projectFacts = client.mounted?.projectFacts;
  const project = useSyncExternalStore(projectFacts?.subscribe ?? unsubscribe,
    () => projectFacts?.getForLocation(location) ?? null, () => null);
  const menu = useWorkbenchContextMenu();
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const peer = snapshot.data?.peers.find(item => item.daemonId === address.daemonId && item.projectId === address.projectId);
  const global = readGlobalWorkbenchSettings(preferences.records);
  const defaultMode = project
    ? resolveWorkbenchSettings(global, readLogicalProjectWorkbenchSettings(project.id, preferences.records)).gitPeerSyncMode
    : global.gitPeerSyncMode;
  const alternate: GitPeerSyncMode = defaultMode === "merge" ? "rebase" : "merge";
  const busy = snapshot.busy?.peerKey === `${address.daemonId}/${address.projectId}` && snapshot.busy.action === action;
  const selected = busy ? snapshot.busy!.mode : shift ? alternate : defaultMode;
  const available = preferences.schemaVersion >= appStateReleases.gitPeerSyncMode.version && project !== null;
  const disabled = !available || !state || !peer || peer.state !== "current" || snapshot.busy !== null;
  const verb = action === "pull" ? "Pull" : "Send";
  const count = peer ? action === "pull" ? peer.behind : peer.ahead : 0;
  const description = (mode: GitPeerSyncMode) => mode === "merge"
    ? "Preserve both histories; merge on the receiving device only if needed."
    : "Rebase unpublished incoming commits on the sending device, then fast-forward the receiver.";
  const transfer = (mode: GitPeerSyncMode) => {
    if (!disabled && state && peer) void state.transfer(action, peer, mode);
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    menu.openContextMenu({ x: bounds.left, y: bounds.bottom, menu: {
      id: `git-peer-${action}-${address.daemonId}-${address.projectId}`,
      label: `${verb} mode`,
      items: (["merge", "rebase"] as const).map(mode => ({
        id: mode, label: `${verb} with ${mode}`, onSelect: () => transfer(mode),
      })),
    } });
  };
  return <span className="inline-flex shrink-0 items-center gap-0.5">
    <PrimaryButton shape="compact" className={className} disabled={disabled} pendingHalo={busy}
      title={!available ? "Reload the app database to enable sync preferences."
        : `${verb} ${peer?.hostname ?? ""}: ${peer?.rootPath ?? ""}. ${description(selected)} Hold Shift for ${shift ? defaultMode : alternate}.`}
      onContextMenu={openMenu}
      onClick={event => transfer(event.shiftKey ? alternate : defaultMode)}>
      {verb}{showCount ? ` ${count}` : ""} · {selected}{showHostname && peer ? ` · ${peer.hostname}` : ""}
    </PrimaryButton>
    <IconButton label={`${verb} mode`} size="compact" display="hover-border" disabled={disabled}
      onClick={openMenu}><MoreVerticalIcon size={14} /></IconButton>
  </span>;
}

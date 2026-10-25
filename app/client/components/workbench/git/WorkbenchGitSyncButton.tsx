/* Exports: default WorkbenchGitSyncButton: preference-aware Pull/Send control choosing fast-forward, the default sync mode, the other one on Shift, or either from its context menu. */
"use client";

import type { MouseEvent, ReactNode } from "react";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type { GitPeerSyncMode, GitPeerTransfer } from "workbench-shared/workbench/git/git-peer-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { useWorkbenchContextMenu } from "../WorkbenchContextMenuContext";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { useSettings } from "../use-settings";
import { useWorkbenchClientState } from "../workbench-client-state-context";
import { GitFastForwardIcon, GitMergeIcon, GitRebaseIcon } from "../workbench-icons";

type SyncMode = GitPeerTransfer["mode"];

export default function WorkbenchGitSyncButton({
  location, verb, fastForward, busyMode, disabled, menuId, count = null, className, tooltip, onTransfer,
}: {
  location: ProjectLocationReference;
  verb: "Pull" | "Send";
  /** Nothing local would be rewritten or merged, so the mode choice does not apply. */
  fastForward: boolean;
  /** The mode of this button's transfer while it runs. */
  busyMode: SyncMode | null;
  disabled: boolean;
  menuId: string;
  count?: number | null;
  className?: string;
  /** `unavailable` explains why the folder's sync setting cannot be read yet. */
  tooltip(mode: SyncMode, unavailable: string | null): ReactNode;
  onTransfer(mode: SyncMode): void;
}) {
  // The folder's project may override the sync mode; until the project is known the setting is unavailable.
  const settings = useSettings.forLocation(location);
  const schemaReady = useWorkbenchClientState(state => state.schemaVersion >= appStateReleases.gitPeerSyncMode.version);
  const menu = useWorkbenchContextMenu();
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const defaultMode = settings.get("gitPeerSyncMode");
  const alternate: GitPeerSyncMode = defaultMode === "merge" ? "rebase" : "merge";
  const selected = busyMode ?? (fastForward ? "fastForward" : shift ? alternate : defaultMode);
  const available = !settings.unavailable("gitPeerSyncMode");
  const blocked = disabled || !available;
  const Icon = selected === "fastForward" ? GitFastForwardIcon : selected === "merge" ? GitMergeIcon : GitRebaseIcon;
  const transfer = (mode: SyncMode) => { if (!blocked) onTransfer(mode); };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (blocked || fastForward) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    menu.openContextMenu({ x: bounds.left, y: bounds.bottom, menu: {
      id: menuId,
      label: `${verb} mode`,
      items: (["merge", "rebase"] as const).map(mode => ({
        id: mode, label: `${verb} with ${mode}`, onSelect: () => transfer(mode),
      })),
    } });
  };
  const unavailable = available ? null : !schemaReady ? "App database reload needed" : "Loading project";
  return <Tooltip placement="top" interactive content={tooltip(selected, unavailable)}>
    <span className="inline-flex shrink-0">
      <PrimaryButton shape="compact" className={className} disabled={blocked} pendingHalo={busyMode !== null}
        onContextMenu={openMenu}
        onClick={event => transfer(fastForward ? "fastForward" : event.shiftKey ? alternate : defaultMode)}>
        <Icon size={14} className="mr-1.5 shrink-0" />
        {verb}{count !== null ? ` ${count}` : ""}{selected !== "fastForward" ? ` · ${selected}` : ""}
      </PrimaryButton>
    </span>
  </Tooltip>;
}

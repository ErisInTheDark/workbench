/*
 * Exports:
 * - default WorkbenchReloadPanel: the sidebar's reload and update panel: this device first, then every other daemon this app
 *   reaches, each with its own reload tree, update and impact, plus the stale-tab refresh.
 */
"use client";

import type { PresentationDraftReference } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore } from "workbench-shared/types";
import PrimaryButton from "../../ui/PrimaryButton";
import { useLocalReloadDevice, useReloadSources, useRemoteReloadDevices } from "./use-reload-devices";
import WorkbenchReloadDevice from "./WorkbenchReloadDevice";

const SIDEBAR_BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";

export default function WorkbenchReloadPanel({ appRuntime, daemonRuntime, onAskAgent }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  onAskAgent: (projectId: string, references: readonly PresentationDraftReference[]) => void;
}) {
  const sources = useReloadSources(appRuntime);
  const local = useLocalReloadDevice({ appRuntime, daemonRuntime, sources, onAskAgent });
  const remotes = useRemoteReloadDevices({ appRuntime, sources });
  return (
    <div className="space-y-2" data-reload-panel="true">
      {sources.tabOutOfDate && !sources.pullRunning ? (
        <div className="flex items-center gap-2 pl-1 text-[0.8rem] text-fg/muted" data-tab-out-of-date="true">
          <span className="min-w-0 flex-1">This tab is out of date</span>
          <PrimaryButton className={SIDEBAR_BUTTON} onClick={() => window.location.reload()} shape="compact">Refresh</PrimaryButton>
        </div>
      ) : null}
      <div>
        <WorkbenchReloadDevice device={local} startOpen />
        {remotes.map(device => <WorkbenchReloadDevice device={device} key={device.key} />)}
      </div>
    </div>
  );
}

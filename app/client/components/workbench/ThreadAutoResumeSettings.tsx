/*
 * Exports:
 * - default ThreadAutoResumeSettings: one daemon's auto resume row: its checkbox and what a thread with an expired cache does.
 */
"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { THREAD_AUTO_RESUME_DEFAULTS, type ThreadAutoResumeSettings as Settings } from "workbench-shared/workbench/settings/thread-auto-resume";
import ThreadAutoResumeSettingsController from "../../workbench/ThreadAutoResumeSettingsController";
import { OptionCard } from "../ui/OptionCards";
import RadioRow from "../ui/RadioRow";

export default function ThreadAutoResumeSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const controller = useMemo(() => new ThreadAutoResumeSettingsController(daemon.threadAutoResume), [daemon]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  const settings = state.settings ?? THREAD_AUTO_RESUME_DEFAULTS;
  const disabled = !state.settings;
  return <div className="grid gap-2">
    <OptionCard label={settings.enabled ? "Enabled" : "Disabled"} ariaLabel="Auto-resume threads" density="tight"
      isSingleChoice={false} isChecked={settings.enabled} disabled={disabled}
      onClick={() => { void controller.update({ enabled: !settings.enabled }); }}
      inlineContent={<span className={`ml-auto flex items-center gap-2 text-[0.8rem] text-fg/muted ${settings.enabled ? "" : "opacity-60"}`}>
        <span className="shrink-0">If cache expired</span>
        <RadioRow<Settings["expiredCache"]> ariaLabel="When a resuming thread's cache expired" disabled={disabled}
          value={settings.expiredCache} onChange={expiredCache => { void controller.update({ expiredCache }); }}
          options={[{ value: "wait", label: "Wait for me" }, { value: "compact", label: "Compact, resume" }]} />
      </span>}
    />
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}

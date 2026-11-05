/*
 * Exports:
 * - default ThreadAutoResumeSettings: one daemon's auto resume row: its checkbox and how long a thread may sit idle and still resume.
 */
"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { THREAD_AUTO_RESUME_DEFAULTS, THREAD_AUTO_RESUME_LIMITS } from "workbench-shared/workbench/settings/thread-auto-resume";
import ThreadAutoResumeSettingsController from "../../workbench/ThreadAutoResumeSettingsController";
import { OptionCard } from "../ui/OptionCards";
import { sliderAccentColour } from "../ui/slider-colours";
import { formatMinutes, Threshold } from "./ThreadAutoCompactSettings";

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
      inlineContent={<span className={`ml-auto flex items-center gap-x-4 ${settings.enabled ? "" : "opacity-60"}`}>
        <Threshold title="Unless idle" label="Auto-resume idle threshold" disabled={disabled} className="w-44"
          {...THREAD_AUTO_RESUME_LIMITS.idleMinutes} value={settings.idleMinutes}
          format={formatMinutes} valueOptions={["120m"]} colour={sliderAccentColour}
          onChange={idleMinutes => { void controller.update({ idleMinutes }); }} />
      </span>}
    />
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}

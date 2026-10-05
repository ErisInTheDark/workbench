/*
 * Exports:
 * - default ThreadAutoCompactSettings: daemon checkbox row containing two compact settings sliders.
 */
"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, THREAD_AUTO_COMPACT_LIMITS } from "workbench-shared/workbench/settings/thread-auto-compact";
import ThreadAutoCompactSettingsController from "../../workbench/ThreadAutoCompactSettingsController";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import WorkbenchStepSlider from "./WorkbenchStepSlider";

function steps({ min, max, step }: { min: number; max: number; step: number }, label: (value: number) => string) {
  return Array.from({ length: (max - min) / step + 1 }, (_, index) => {
    const value = min + index * step;
    return { value, label: label(value) };
  });
}
const tokenSteps = steps(THREAD_AUTO_COMPACT_LIMITS.tokens, value => `${value / 1_000}k`);
const idleSteps = steps(THREAD_AUTO_COMPACT_LIMITS.idleMinutes, value => `${value} min`);

export default function ThreadAutoCompactSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const controller = useMemo(() => new ThreadAutoCompactSettingsController(daemon.threadAutoCompact), [daemon]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  const settings = state.settings ?? DEFAULT_THREAD_AUTO_COMPACT_SETTINGS;
  const disabled = !state.settings || state.pending;
  return <section className="py-1">
    <WorkbenchOptionCard label="Auto-compact" density="tight" isSingleChoice={false}
      isChecked={settings.enabled} disabled={disabled}
      onClick={() => { void controller.update({ enabled: !settings.enabled }); }}
      inlineContent={<>
        <WorkbenchStepSlider compact ariaLabel="Auto-compact token threshold" disabled={disabled}
          steps={tokenSteps} value={settings.tokenThreshold}
          onChange={tokenThreshold => { void controller.update({ tokenThreshold }); }} />
        <WorkbenchStepSlider compact ariaLabel="Auto-compact idle threshold" disabled={disabled}
          steps={idleSteps} value={settings.idleMinutes}
          onChange={idleMinutes => { void controller.update({ idleMinutes }); }} />
      </>}
    >
      {state.error ? <p role="alert" className="m-0 text-xs text-danger">
        {state.error} <button type="button" className="rounded px-2 py-1 hover:bg-button-hover"
          onClick={() => { void controller.load(); }}>Retry</button>
      </p> : null}
    </WorkbenchOptionCard>
  </section>;
}

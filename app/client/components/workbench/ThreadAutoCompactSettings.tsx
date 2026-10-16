/*
 * Exports:
 * - default ThreadAutoCompactSettings: one daemon's auto-compact checkbox row with inline token and idle threshold sliders.
 */
"use client";
import { useEffect, useMemo, useSyncExternalStore, type ComponentProps } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, THREAD_AUTO_COMPACT_LIMITS } from "workbench-shared/workbench/settings/thread-auto-compact";
import ThreadAutoCompactSettingsController from "../../workbench/ThreadAutoCompactSettingsController";
import { OptionCard } from "../ui/OptionCards";
import PressDragSlider from "../ui/PressDragSlider";
import { sliderAccentColour, sliderSpectrumColour } from "../ui/slider-colours";

function formatTokens(tokens: number) {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}K`;
}

function Threshold({ title, ...slider }: Omit<ComponentProps<typeof PressDragSlider>, "presentation"> & { title: string }) {
  return <span className="flex w-44 min-w-0 items-center gap-2 text-[0.8rem] text-fg/muted">
    <span className="shrink-0">{title}</span>
    <PressDragSlider {...slider} presentation="inline" />
  </span>;
}

export default function ThreadAutoCompactSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const controller = useMemo(() => new ThreadAutoCompactSettingsController(daemon.threadAutoCompact), [daemon]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  const settings = state.settings ?? DEFAULT_THREAD_AUTO_COMPACT_SETTINGS;
  const loading = !state.settings;
  return <OptionCard label="Compact idle threads" density="tight"
    isSingleChoice={false} isChecked={settings.enabled} disabled={loading}
    onClick={() => { void controller.update({ enabled: !settings.enabled }); }}
    inlineContent={<span className={`ml-auto flex flex-wrap items-center gap-x-5 ${settings.enabled ? "" : "opacity-60"}`}>
      <Threshold title="Over" label="Auto-compact token threshold" disabled={loading}
        {...THREAD_AUTO_COMPACT_LIMITS.tokens} value={settings.tokenThreshold}
        format={formatTokens} valueOptions={["1M", "975K"]} colour={sliderSpectrumColour}
        onChange={tokenThreshold => { void controller.update({ tokenThreshold }); }} />
      <Threshold title="Idle" label="Auto-compact idle threshold" disabled={loading}
        {...THREAD_AUTO_COMPACT_LIMITS.idleMinutes} value={settings.idleMinutes}
        format={minutes => `${minutes}m`} valueOptions={["120m"]} colour={sliderAccentColour}
        onChange={idleMinutes => { void controller.update({ idleMinutes }); }} />
    </span>}
  >
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </OptionCard>;
}

/*
 * Exports:
 * - formatMinutes: show a threshold's minutes compactly.
 * - Threshold: one titled inline slider in an automation settings row.
 * - default ThreadAutoCompactSettings: one daemon's auto-compact rows, one per provider: its checkbox, its idle rule where it has one, OR its turn-end rule.
 */
"use client";
import { useEffect, useMemo, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { installedProviderKeys, type WorkbenchProviderKey } from "workbench-shared/workbench/provider/provider-registrations";
import {
  THREAD_AUTO_COMPACT_DEFAULTS, THREAD_AUTO_COMPACT_LIMITS, type ThreadAutoCompactPatch, type ThreadAutoCompactRules,
} from "workbench-shared/workbench/settings/thread-auto-compact";
import ThreadAutoCompactSettingsController from "../../workbench/ThreadAutoCompactSettingsController";
import { providerLabels } from "../../workbench/provider-labels";
import { OptionCard } from "../ui/OptionCards";
import PressDragSlider from "../ui/PressDragSlider";
import { sliderAccentColour, sliderSpectrumColour } from "../ui/slider-colours";
import { HarnessIcon } from "./workbench-icons";

function formatTokens(tokens: number) {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}K`;
}

export function formatMinutes(minutes: number) {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export function Threshold({ title, className = "w-32", ...slider }: Omit<ComponentProps<typeof PressDragSlider>, "presentation" | "className"> & { title: string; className?: string }) {
  return <span className={`flex min-w-0 items-center gap-2 text-[0.8rem] text-fg/muted ${className}`}>
    <span className="shrink-0">{title}</span>
    <PressDragSlider {...slider} presentation="inline" />
  </span>;
}

function TokenThreshold({ title, label, value, min, disabled, onChange }: {
  title: string; label: string; value: number; min?: number; disabled: boolean; onChange: (value: number) => void;
}) {
  return <Threshold title={title} label={label} disabled={disabled}
    {...THREAD_AUTO_COMPACT_LIMITS.tokens} min={min ?? THREAD_AUTO_COMPACT_LIMITS.tokens.min} value={value}
    format={formatTokens} valueOptions={["1M", "975K"]} colour={sliderSpectrumColour} onChange={onChange} />;
}

function ProviderRules({ provider, rules, disabled, onChange }: {
  provider: WorkbenchProviderKey; rules: ThreadAutoCompactRules; disabled: boolean; onChange: (patch: ThreadAutoCompactPatch) => void;
}) {
  const name = providerLabels[provider];
  const label: ReactNode = <span className="flex items-center gap-2"><HarnessIcon harness={provider} className="size-4" />{name}</span>;
  return <OptionCard label={label} ariaLabel={`Auto-compact ${name} threads`} density="tight"
    isSingleChoice={false} isChecked={rules.enabled} disabled={disabled}
    onClick={() => onChange({ enabled: !rules.enabled })}
    inlineContent={<span className={`ml-auto flex items-center gap-x-4 ${rules.enabled ? "" : "opacity-60"}`}>
      {rules.idle ? <>
        <TokenThreshold title="Over" label={`${name} idle token threshold`} disabled={disabled}
          value={rules.idle.tokenThreshold} onChange={tokenThreshold => onChange({ tokenThreshold })} />
        <Threshold title="Idle" label={`${name} idle threshold`} disabled={disabled}
          {...THREAD_AUTO_COMPACT_LIMITS.idleMinutes} value={rules.idle.minutes}
          format={formatMinutes} valueOptions={["120m"]} colour={sliderAccentColour}
          onChange={idleMinutes => onChange({ idleMinutes })} />
        <span className="text-base font-medium tracking-wider text-fg/muted">OR</span>
      </> : null}
      <TokenThreshold title="Over" label={`${name} turn-end token threshold`} disabled={disabled}
        min={rules.idle?.tokenThreshold} value={rules.turnEndTokenThreshold}
        onChange={turnEndTokenThreshold => onChange({ turnEndTokenThreshold })} />
    </span>}
  />;
}

export default function ThreadAutoCompactSettings({ daemon }: { daemon: WorkbenchDaemonClient }) {
  const controller = useMemo(() => new ThreadAutoCompactSettingsController(daemon.threadAutoCompact), [daemon]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  const settings = state.settings ?? THREAD_AUTO_COMPACT_DEFAULTS;
  return <div className="grid gap-2">
    {installedProviderKeys.map(provider => <ProviderRules key={provider} provider={provider} rules={settings[provider]}
      disabled={!state.settings} onChange={patch => { void controller.update(provider, patch); }} />)}
    {state.error ? <p role="alert" className="m-0 text-xs text-danger">{state.error}</p> : null}
  </div>;
}

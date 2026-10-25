/*
 * Exports:
 * - default WorkbenchReloadFooterPill: the sidebar footer's reload control. This device's next action as one talking pill
 *   ("Reload", "Restart app", "↓3", "Refresh tab", "Resolve conflicts") joined to a devices button that opens the reload
 *   panel; with nothing to do, only the devices button shows. A dot on it says another device needs something.
 */
"use client";

import type { ReactNode } from "react";

import IconButton from "../../ui/IconButton";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { threadStatusPressedClassName } from "../thread-view/ThreadStatusRow";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import WorkbenchSpinningBorder from "../WorkbenchSpinningBorder";
import {
  ArrowDownIcon, BotIcon, ComputerIcon, DatabaseArrowUpIcon, RefreshCwIcon, ReloadIcon, ResetIcon,
} from "../workbench-icons";
import ReloadImpactChips from "./ReloadImpactChips";
import { useReloadRequest, type ReloadDeviceState } from "./use-reload-devices";
import { UpdateImpactTip } from "./WorkbenchReloadDevice";

/** One fixed height so word and icon segments line up; the fill insets to leave the halo its gutter. */
const SEGMENT = "!h-8 !shrink-0 !py-0 [&>span:first-of-type]:!inset-[3px]";

const needsAttention = (device: ReloadDeviceState) =>
  Boolean(device.plan.reload || device.plan.update || device.plan.issue || device.running);
const restarts = (device: ReloadDeviceState) =>
  Boolean(device.plan.reload?.danger || device.plan.update?.impact?.restarts.length);

function DeviceAttention({ devices }: { devices: readonly ReloadDeviceState[] }) {
  return (
    <span className="flex flex-col gap-1">
      <span>Every device's reloads and updates</span>
      {devices.map(device => {
        const impact = device.plan.reload ?? device.plan.update?.impact ?? null;
        return (
          <span className="flex items-center gap-1.5" key={device.key}>
            <span className="font-semibold">{device.name}</span>
            {device.running ?? (device.plan.issue ? "needs an agent" : null)}
            {device.plan.update ? <span className="inline-flex items-center"><ArrowDownIcon size={12} />{device.plan.update.count}</span> : null}
            {impact ? <ReloadImpactChips impact={impact} /> : null}
          </span>
        );
      })}
    </span>
  );
}

function DevicesButton({ attention, joined, afterDisabled, pressed, onOpen }: {
  attention: readonly ReloadDeviceState[];
  joined: boolean;
  /** Beside a disabled segment the hairline goes; the disabled ring already draws that edge. */
  afterDisabled: boolean;
  pressed: boolean;
  onOpen(): void;
}) {
  const glyph = (
    <span className="relative inline-flex">
      <ComputerIcon size={14} />
      {attention.length ? (
        <span className={`absolute -right-1 -top-1 size-2 rounded-full ${attention.some(restarts) ? "bg-danger" : "bg-accent"}`} />
      ) : null}
    </span>
  );
  return (
    <Tooltip content={attention.length ? <DeviceAttention devices={attention} /> : "Every device's reloads and updates"}>
      {joined ? (
        <PrimaryButton
          aria-label="Open reloads and updates"
          aria-pressed={pressed}
          className={`${SEGMENT} !pl-2 !pr-2.5 ${afterDisabled ? "after:!hidden" : ""}`}
          onClick={onOpen}
          segment="end"
          shape="compact"
        >
          {glyph}
        </PrimaryButton>
      ) : (
        <IconButton
          aria-pressed={pressed}
          className={pressed ? threadStatusPressedClassName : ""}
          display="hover-border"
          label="Open reloads and updates"
          onClick={onOpen}
          shape="pill"
          size="small"
        >
          <span className="inline-flex items-center px-1.5">{glyph}</span>
        </IconButton>
      )}
    </Tooltip>
  );
}

/** "Reload", or what it restarts, so the button is its own warning; a database glyph when a store migrates. */
function ReloadWords({ reload }: { reload: NonNullable<ReloadDeviceState["plan"]["reload"]> }) {
  return (
    <span className="flex min-w-0 items-center whitespace-nowrap">
      {reload.danger ? <ResetIcon className="mr-1 shrink-0" size={14} /> : <ReloadIcon className="mr-1 shrink-0" size={14} />}
      <span className="truncate">{reload.danger ? `Restart ${reload.restarts.join(", ")}` : "Reload"}</span>
      {reload.migrates ? <DatabaseArrowUpIcon className="ml-1 shrink-0" size={12} /> : null}
    </span>
  );
}

export default function WorkbenchReloadFooterPill({ local, remotes, tabOutOfDate, pressed, onOpen }: {
  local: ReloadDeviceState;
  remotes: readonly ReloadDeviceState[];
  /** The tab predates the running app and no pull is about to refresh it. */
  tabOutOfDate: boolean;
  /** The reload panel is showing. */
  pressed: boolean;
  onOpen(): void;
}) {
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  const { request, requesting, error: requestError } = useReloadRequest();
  const { plan, ports } = local;
  const disabled = local.disabled || requesting || local.pendingScopes.length > 0;
  const error = requestError || local.error;
  const update = plan.update && !plan.update.blocked && !plan.issue ? plan.update : null;
  const attention = [...plan.issue && !local.resolve ? [local] : [], ...remotes.filter(needsAttention)];

  const main: ReactNode = (() => {
    if (local.running) {
      return <PrimaryButton className={SEGMENT} disabled segment="start" shape="compact">{local.running}</PrimaryButton>;
    }
    if (plan.issue && local.resolve) {
      return (
        <PrimaryButton className={SEGMENT} disabled={disabled} onClick={local.resolve} segment="start" shape="compact" tone="attention">
          <BotIcon className="mr-1" size={14} />{plan.issue === "failure" ? "Resolve issues" : "Resolve conflicts"}
        </PrimaryButton>
      );
    }
    if (plan.reload || update) {
      const pullOnly = shift;
      const updateDanger = Boolean(update && !pullOnly && (update.danger || plan.reload?.danger));
      return <>
        {plan.reload ? (
          <PrimaryButton
            className={SEGMENT}
            disabled={disabled}
            holdToConfirmMs={plan.reload.holdMs}
            onClick={() => request(ports.reloadAll)}
            segment="start"
            shape="compact"
            tone={plan.reload.danger ? "danger" : "default"}
          >
            <ReloadWords reload={plan.reload} />
          </PrimaryButton>
        ) : null}
        {update ? (
          <Tooltip content={<UpdateImpactTip plan={update} />}>
            <PrimaryButton
              className={SEGMENT}
              disabled={disabled}
              holdToConfirmMs={updateDanger ? Math.max(update.holdMs, plan.reload?.holdMs ?? 0) : update.holdMs}
              onClick={() => request(() => ports.pull(!pullOnly))}
              segment={plan.reload ? "middle" : "start"}
              shape="compact"
              tone={updateDanger ? "danger" : "default"}
            >
              <ArrowDownIcon size={14} />
              <span className="ml-0.5">{pullOnly ? `Pull ${update.count}` : plan.reload ? update.count : `Update ${update.count}`}</span>
            </PrimaryButton>
          </Tooltip>
        ) : null}
      </>;
    }
    if (tabOutOfDate) {
      return (
        <PrimaryButton className={SEGMENT} onClick={() => window.location.reload()} segment="start" shape="compact">
          <RefreshCwIcon className="mr-1" size={14} />Refresh tab
        </PrimaryButton>
      );
    }
    return null;
  })();

  const pill = <>
    {main ? (error ? <Tooltip content={<span className="text-danger">{error}</span>}><span className="flex">{main}</span></Tooltip> : main) : null}
    <DevicesButton
      afterDisabled={Boolean(local.running)}
      attention={attention}
      joined={main !== null}
      onOpen={onOpen}
      pressed={pressed}
    />
  </>;
  return local.running ? (
    <span className="relative isolate flex h-8 shrink-0 items-center">
      <WorkbenchSpinningBorder radius="50cqb" />
      {pill}
    </span>
  ) : <span className="flex shrink-0 items-center">{pill}</span>;
}

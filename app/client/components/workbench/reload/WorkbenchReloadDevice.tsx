/*
 * Exports:
 * - WorkbenchReloadDevicePorts: the reload and update intents one device's controls send.
 * - default WorkbenchReloadDevice: one device as a disclosure: its name with tiny impact chips, a joined Reload | update pill
 *   (or one plain "Update & reload" for update-only devices), and its dirt tree when open.
 */
"use client";

import { useState } from "react";

import type { WorkbenchReloadDirtScope } from "workbench-shared/types";
import PrimaryButton from "../../ui/PrimaryButton";
import Tooltip from "../../ui/Tooltip";
import { useNonTextInputShiftKey } from "../use-non-text-input-shift-key";
import { ArrowDownIcon, BotIcon, ChevronDownIcon, ReloadIcon } from "../workbench-icons";
import ReloadImpactChips from "./ReloadImpactChips";
import type { ReloadDevicePlan } from "./reload-device";
import WorkbenchReloadTree from "./WorkbenchReloadTree";

const SIDEBAR_BUTTON = "!shrink-0 [&>span:first-of-type]:!inset-[3px]";

export interface WorkbenchReloadDevicePorts {
  reloadScope(scope: WorkbenchReloadDirtScope): Promise<unknown>;
  reloadAll(): Promise<unknown>;
  pull(reload: boolean): Promise<unknown>;
}

function UpdateImpactTip({ plan }: { plan: NonNullable<ReloadDevicePlan["update"]> }) {
  return (
    <span className="flex max-w-60 flex-wrap items-center gap-1.5">
      <span>
        Pull {plan.count} {plan.count === 1 ? "update" : "updates"}, then reload everything.
        {plan.impact ? "" : " What it reloads is not known yet."}
      </span>
      {plan.impact ? <ReloadImpactChips impact={plan.impact} /> : null}
    </span>
  );
}

function DeviceActions({ local, plan, disabled, running, ports, onResolve, onRequest }: {
  local: boolean;
  plan: ReloadDevicePlan;
  disabled: boolean;
  running: string | null;
  ports: WorkbenchReloadDevicePorts;
  onResolve: (() => void) | null;
  onRequest(request: () => Promise<unknown>): void;
}) {
  const shift = useNonTextInputShiftKey({ allowWhileTextInputFocused: true });
  if (running) {
    return <PrimaryButton className={SIDEBAR_BUTTON} disabled pendingHalo shape="compact">{running}</PrimaryButton>;
  }
  const reload = plan.reload;
  const update = plan.update && !plan.update.blocked && !plan.issue ? plan.update : null;
  // Shift pulls without reloading; only this device's app can sequence that.
  const pullOnly = local && shift;
  const reloadButton = reload ? (
    <PrimaryButton
      className={SIDEBAR_BUTTON}
      disabled={disabled}
      holdToConfirmMs={reload.holdMs}
      onClick={() => onRequest(ports.reloadAll)}
      segment={update ? "start" : undefined}
      shape="compact"
      title={reload.danger ? `Reload all, restarting ${reload.restarts.join(", ")}` : "Reload all"}
      tone={reload.danger ? "danger" : "default"}
    >
      <ReloadIcon className="mr-1" size={14} />Reload
    </PrimaryButton>
  ) : null;
  const updateDanger = Boolean(update && !pullOnly && (update.danger || reload?.danger));
  const updateButton = update ? (
    <Tooltip content={<UpdateImpactTip plan={update} />}>
      <PrimaryButton
        className={SIDEBAR_BUTTON}
        disabled={disabled}
        holdToConfirmMs={updateDanger ? Math.max(update.holdMs, reload?.holdMs ?? 0) : update.holdMs}
        onClick={() => onRequest(() => ports.pull(!pullOnly))}
        segment={reload ? "end" : undefined}
        shape="compact"
        tone={updateDanger ? "danger" : "default"}
      >
        <ArrowDownIcon size={14} />
        {pullOnly ? <span className="ml-1">Pull {update.count}</span>
          : reload ? <span className="ml-0.5">{update.count}</span> : <span className="ml-1">Update & reload</span>}
      </PrimaryButton>
    </Tooltip>
  ) : null;
  const quietUpdate = plan.update && (plan.update.blocked || plan.issue && !onResolve) ? (
    <Tooltip content={plan.update.blocked ?? "This update conflicts with local work; resolve it on that device."}>
      <span className="inline-flex items-center gap-0.5 pr-1 text-[0.74rem] text-fg/muted">
        <ArrowDownIcon size={12} />{plan.update.count}
      </span>
    </Tooltip>
  ) : null;
  const resolveButton = plan.issue && onResolve ? (
    <PrimaryButton className={SIDEBAR_BUTTON} disabled={disabled} onClick={onResolve} shape="compact" tone="attention">
      <BotIcon className="mr-1" size={14} />{plan.issue === "failure" ? "Resolve issues" : "Resolve conflicts"}
    </PrimaryButton>
  ) : null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {quietUpdate}
      <span className="flex items-center">{reloadButton}{updateButton}</span>
      {resolveButton}
    </span>
  );
}

export default function WorkbenchReloadDevice({
  name, local, plan, startOpen = false, pendingScopes, running, disabled, error, unavailable, ports, onResolve,
}: {
  name: string;
  local: boolean;
  plan: ReloadDevicePlan;
  startOpen?: boolean;
  pendingScopes: readonly string[];
  /** The running operation's label when it targets this device. */
  running: string | null;
  disabled: boolean;
  error: string | null;
  /** Why this device cannot be reached; it shows instead of controls. */
  unavailable: string | null;
  ports: WorkbenchReloadDevicePorts;
  onResolve: (() => void) | null;
}) {
  const [open, setOpen] = useState(startOpen);
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const pending = new Set(pendingScopes);
  const hasTree = plan.tree.length > 0;
  const expanded = open && hasTree;
  // Open devices show the tree instead; update-only devices preview what the update would do.
  const impact = plan.reload ?? plan.update?.impact ?? null;
  const chips = !expanded && impact && (impact.restarts.length || impact.migrates) ? <ReloadImpactChips impact={impact} /> : null;
  const quiet = unavailable ?? (!plan.reload && !plan.update && !plan.issue && !running ? "up to date" : null);
  const request = (send: () => Promise<unknown>) => {
    setRequestError("");
    setRequesting(true);
    void send().catch((failure: unknown) => {
      setRequestError(failure instanceof Error ? failure.message : "The reload request failed.");
    }).finally(() => setRequesting(false));
  };
  const blocked = disabled || requesting || pending.size > 0;
  const shownError = requestError || error;
  return (
    <section className="border-b border-fg/8 py-1.5 last:border-b-0">
      <div className="flex min-h-9 min-w-0 items-center gap-2">
        <button
          aria-expanded={hasTree ? expanded : undefined}
          className="flex min-w-0 flex-1 items-start gap-1 rounded-lg text-left enabled:cursor-pointer"
          disabled={!hasTree}
          onClick={() => setOpen(!open)}
          type="button"
        >
          <span className="flex h-6 w-5 shrink-0 items-center justify-center text-fg/muted">
            <ChevronDownIcon
              className={`transition-transform ${hasTree ? "" : "opacity-0"} ${expanded ? "" : "-rotate-90"}`}
              size={12}
            />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[0.92rem] font-semibold leading-6 text-text">{name}</span>
            {chips || quiet ? (
              <span className="flex min-h-3 items-center text-[0.72rem] text-fg/muted">{chips ?? quiet}</span>
            ) : null}
          </span>
        </button>
        {unavailable ? null : (
          <DeviceActions
            disabled={blocked}
            local={local}
            onRequest={request}
            onResolve={onResolve}
            plan={plan}
            ports={ports}
            running={running}
          />
        )}
      </div>
      {expanded ? (
        <div className="pb-1 pt-0.5">
          <WorkbenchReloadTree
            disabled={blocked}
            nodes={plan.tree}
            onReload={scope => request(() => ports.reloadScope(scope))}
            pendingScopes={pending}
          />
        </div>
      ) : null}
      {shownError ? <p className="m-0 pl-6 pt-1 text-[0.74rem] leading-4 text-danger">{shownError}</p> : null}
    </section>
  );
}

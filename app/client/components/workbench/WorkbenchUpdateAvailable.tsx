/*
 * Exports:
 * - hasVisibleInstallationUpdate: whether an update is available (or being pulled) for the running checkout.
 * - default WorkbenchUpdateAvailable: "Update available" with one action: pull & reload, or hand a conflicting or previously
 *   failed update to an agent.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";

import type { InstallationUpdate } from "workbench-shared/workbench/installation-update";
import type { WorkbenchReloadOperation } from "workbench-shared/reload/workbench-reload";
import { IDLE_RELOAD_OPERATION } from "workbench-shared/reload/workbench-reload";
import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore } from "workbench-shared/types";
import { useWorkbenchAppConnectionInterrupted } from "../../workbench/app/WorkbenchAppRpcContext";
import PrimaryButton from "./PrimaryButton";
import { BotIcon } from "./workbench-icons";

const PULL_HOLD_MS = 1_000;
const NO_SUBSCRIPTION = () => () => undefined;
const PULL_ACTIONS = new Set<WorkbenchReloadOperation["action"]>(["pull", "pullAndReload"]);
const BUTTON = "!shrink-0 !px-2.5 !py-1.5 !text-[0.76rem] [&>span:first-of-type]:!inset-[3px]";

export function hasVisibleInstallationUpdate(update: InstallationUpdate | null, operation: WorkbenchReloadOperation) {
  return Boolean(
    update?.state === "available" || update?.state === "conflict"
    || (PULL_ACTIONS.has(operation.action) && operation.phase !== "idle"),
  );
}

// Prompts are agent-facing, so they carry the detail the button deliberately leaves out.
function conflictPrompt(update: InstallationUpdate) {
  const source = update.upstream ?? "upstream";
  return update.conflicts.length
    ? `Pulling Workbench updates from \`${source}\` would conflict with local changes in:\n\n${update.conflicts.map(file => `- \`${file}\``).join("\n")}\n\nHelp me resolve this so the update can be pulled, preserving my local work.`
    : `Rebasing my local Workbench commits onto \`${source}\` would conflict. Help me resolve this so the update can be pulled, preserving my local work.`;
}

function failurePrompt(update: InstallationUpdate, failure: NonNullable<InstallationUpdate["failure"]>) {
  return `The last Workbench update from \`${update.upstream ?? "upstream"}\` broke while installing: ${failure.message}\n\nThe update log is at \`${failure.logPath}\`. Help me find the cause and get this update installed.`;
}

const OPERATION_LABELS: Partial<Record<WorkbenchReloadOperation["phase"], string>> = {
  pulling: "Pulling",
  waiting: "Reloading",
  reloading: "Reloading",
  restarting: "Restarting",
};

/** Shift is display state: it only relabels the pull button, and the action is fixed when a hold starts. */
function useShiftHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const read = (event: globalThis.KeyboardEvent) => setHeld(event.shiftKey);
    const reset = () => setHeld(false);
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}

export default function WorkbenchUpdateAvailable({ appRuntime, daemonRuntime, onAskAgent }: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  onAskAgent(projectId: string, prompt: string): void;
}) {
  // The app never server-renders; store reads double as server snapshots so static renders show real states.
  const readUpdate = () => daemonRuntime?.getUpdate() ?? null;
  const readOperation = () => appRuntime?.getOperation() ?? IDLE_RELOAD_OPERATION;
  const readRuntime = () => appRuntime?.getSnapshot() ?? null;
  const update = useSyncExternalStore(daemonRuntime?.subscribeUpdate ?? NO_SUBSCRIPTION, readUpdate, readUpdate);
  const operation = useSyncExternalStore(appRuntime?.subscribeOperation ?? NO_SUBSCRIPTION, readOperation, readOperation);
  const runtime = useSyncExternalStore(appRuntime?.subscribe ?? NO_SUBSCRIPTION, readRuntime, readRuntime);
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const shiftHeld = useShiftHeld();
  const [holdPullOnly, setHoldPullOnly] = useState<boolean | null>(null);
  const [requestError, setRequestError] = useState("");
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const sawOperation = useRef(false);

  const pullRunning = PULL_ACTIONS.has(operation.action) && operation.phase !== "idle" && operation.phase !== "failed";
  const pullFailed = PULL_ACTIONS.has(operation.action) && operation.phase === "failed";
  const pullOnly = holdPullOnly ?? shiftHeld;

  // A pull & reload started here refreshes this tab once the app settled: connected, idle, nothing pending.
  useEffect(() => {
    if (!awaitingRefresh) return;
    if (operation.phase !== "idle") {
      sawOperation.current = true;
      if (operation.phase === "failed") setAwaitingRefresh(false);
      return;
    }
    if (!sawOperation.current || interrupted || runtime?.pendingScopes.length) return;
    if (runtime?.tabOutOfDate) window.location.reload();
    else setAwaitingRefresh(false);
  }, [awaitingRefresh, interrupted, operation.phase, runtime?.pendingScopes.length, runtime?.tabOutOfDate]);

  if (!hasVisibleInstallationUpdate(update, operation)) return null;

  const pull = async (reload: boolean) => {
    setRequestError("");
    if (reload) {
      sawOperation.current = false;
      setAwaitingRefresh(true);
    }
    try {
      if (!appRuntime) throw new Error("Workbench app update controls are not ready.");
      await appRuntime.pull({ reload });
    } catch (error) {
      setAwaitingRefresh(false);
      setRequestError(error instanceof Error ? error.message : "Unable to pull the Workbench update.");
    }
  };
  const beginHold = (shiftKey: boolean) => setHoldPullOnly(shiftKey);
  const endHold = () => setHoldPullOnly(null);

  const askAgent = (prompt: string) => {
    if (update?.projectId) onAskAgent(update.projectId, prompt);
  };
  // The repair breadcrumb has done its job once an agent has the log.
  const resolveFailedUpdate = (failure: NonNullable<InstallationUpdate["failure"]>) => {
    if (!update) return;
    askAgent(failurePrompt(update, failure));
    void daemonRuntime?.dismissUpdateFailure().catch((error: unknown) => {
      setRequestError(error instanceof Error ? error.message : "Unable to clear the failed update record.");
    });
  };

  return (
    <div className="space-y-1.5" data-update-available="true">
      <div className="flex items-center justify-between gap-1.5">
        <p className="m-0 min-w-0 truncate pl-1 font-semibold text-text">Update available</p>
        {pullRunning ? (
          <PrimaryButton className={BUTTON} disabled pendingHalo>
            {interrupted ? "Reconnecting" : OPERATION_LABELS[operation.phase] ?? "Updating"}
          </PrimaryButton>
        ) : update?.failure ? (
          <PrimaryButton className={BUTTON} disabled={!update.projectId} onClick={() => update.failure && resolveFailedUpdate(update.failure)} tone="attention">
            <BotIcon className="mr-1" size={14} />
            Resolve issues
          </PrimaryButton>
        ) : update?.state === "conflict" ? (
          <PrimaryButton className={BUTTON} disabled={!update.projectId} onClick={() => askAgent(conflictPrompt(update))} tone="attention">
            <BotIcon className="mr-1" size={14} />
            Resolve conflicts
          </PrimaryButton>
        ) : update?.state === "available" ? (
          <PrimaryButton
            className={BUTTON}
            disabled={!appRuntime || interrupted}
            holdToConfirmMs={PULL_HOLD_MS}
            onBlur={endHold}
            onClick={() => {
              const reload = !pullOnly;
              endHold();
              void pull(reload);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if ((event.key === "Enter" || event.key === " ") && !event.repeat) beginHold(event.shiftKey);
            }}
            onKeyUp={endHold}
            onPointerCancel={endHold}
            onPointerDown={(event: PointerEvent<HTMLButtonElement>) => beginHold(event.shiftKey)}
            onPointerUp={endHold}
            tone={pullOnly ? "default" : "danger"}
          >
            {pullOnly ? "Pull changes" : "Pull & reload"}
          </PrimaryButton>
        ) : null}
      </div>
      {requestError || (pullFailed && operation.error) ? (
        <p className="m-0 pl-1 text-[0.74rem] leading-4 text-danger">{requestError || operation.error}</p>
      ) : null}
    </div>
  );
}

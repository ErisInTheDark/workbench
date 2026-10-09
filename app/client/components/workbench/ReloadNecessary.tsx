/*
 * Exports:
 * - default ReloadNecessary: render the checkout update section and runtime reload controls, with a separate stale-tab footer action, in the shared sticky card.
 */
"use client";

import { useState, useSyncExternalStore, type ComponentProps } from "react";

import type { WorkbenchAppRuntimeStore, WorkbenchDaemonRuntimeStore, WorkbenchReloadDirtScope } from "workbench-shared/types";
import { IDLE_RELOAD_OPERATION } from "workbench-shared/reload/workbench-reload";
import { partitionReloadScopes } from "workbench-shared/reload/reload-scope-partition";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { useWorkbenchAppConnectionInterrupted } from "../../workbench/app/WorkbenchAppRpcContext";
import ChevronIcon from "./ChevronIcon";
import PrimaryButton from "./PrimaryButton";
import WorkbenchStickyCard from "./WorkbenchStickyCard";
import WorkbenchUpdateAvailable, { hasVisibleInstallationUpdate } from "./WorkbenchUpdateAvailable";
import {
  getAffectedReloadScopes,
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
  mergeReloadDirt,
} from "./reload-necessary-state";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";

const EMPTY_SUBSCRIBE = () => () => undefined;
const DIVIDER = "border-[color-mix(in_srgb,var(--text)_12%,transparent)]";

/** A reload that replaces the process serving the request drops it; reconnected facts decide the outcome. */
function isConnectionInterruption(error: unknown) {
  return error instanceof WorkbenchRpcRequestInterruptedError || error instanceof TypeError;
}

export default function ReloadNecessary ({
  appRuntime,
  daemonRuntime,
  onAskAgent,
}: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  daemonRuntime: WorkbenchDaemonRuntimeStore | null;
  onAskAgent: ComponentProps<typeof WorkbenchUpdateAvailable>["onAskAgent"];
}) {
  const [hoveredScope, setHoveredScope] = useState<string | "all" | null>(null);
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState<string[]>([]);
  const { preferences, setReloadNecessaryOpen } = useWorkbenchSidebarPreferences();
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const collapsed = !preferences.reloadNecessaryOpen;
  const daemonDirt = useSyncExternalStore(
    daemonRuntime?.subscribe ?? EMPTY_SUBSCRIBE,
    daemonRuntime?.getSnapshot ?? (() => null),
    () => null,
  );
  const appDirt = useSyncExternalStore(
    appRuntime?.subscribe ?? EMPTY_SUBSCRIBE,
    appRuntime?.getSnapshot ?? (() => null),
    () => null,
  );
  const update = useSyncExternalStore(
    daemonRuntime?.subscribeUpdate ?? EMPTY_SUBSCRIBE,
    () => daemonRuntime?.getUpdate() ?? null,
    () => null,
  );
  const operation = useSyncExternalStore(
    appRuntime?.subscribeOperation ?? EMPTY_SUBSCRIBE,
    () => appRuntime?.getOperation() ?? IDLE_RELOAD_OPERATION,
    () => IDLE_RELOAD_OPERATION,
  );
  const dirt = mergeReloadDirt(appDirt, daemonDirt);
  const tabOutOfDate = appDirt?.tabOutOfDate ?? false;
  const reloadAllRunning = operation.action === "reloadAll" && operation.phase !== "idle" && operation.phase !== "failed";
  const reloadAllError = operation.action === "reloadAll" && operation.phase === "failed" ? operation.error : null;
  const hasReloadDirt = Boolean(dirt && (dirt.dirtyScopes.length || dirt.error || dirt.pendingScopes.length)) || reloadAllRunning;
  const showUpdate = hasVisibleInstallationUpdate(update, operation);
  const showReloadBody = hasReloadDirt && !collapsed;

  const pending = new Set(dirt?.pendingScopes ?? []);
  const reloadableScopes = dirt?.dirtyScopes ?? [];
  const runRequest = async (selected: string[], request: () => Promise<unknown>) => {
    setRequestError("");
    setRequesting(selected);
    try {
      await request();
    } catch (error) {
      if (!isConnectionInterruption(error)) {
        setRequestError(error instanceof Error ? error.message : "Unable to reload the selected scopes.");
      }
    } finally {
      setRequesting([]);
    }
  };
  const reloadScope = (scope: WorkbenchReloadDirtScope) => runRequest([scope.scope], async () => {
    const owners = partitionReloadScopes([scope.scope]);
    await Promise.all([
      owners.client.length
        ? appRuntime?.reloadScopes(owners.client) ?? Promise.reject(new Error("Workbench app reload controls are not ready."))
        : undefined,
      owners.server.length
        ? daemonRuntime?.reloadScopes(owners.server) ?? Promise.reject(new Error("Workbench daemon reload controls are not ready."))
        : undefined,
    ]);
  });
  const reloadAll = () => runRequest(reloadableScopes.map(({ scope }) => scope), async () => {
    if (!appRuntime) throw new Error("Workbench app reload controls are not ready.");
    await appRuntime.reloadAll();
  });
  const allBusy = Boolean(dirt?.pendingScopes.length || requesting.length || reloadAllRunning);
  const affectedScopes = allBusy
    ? new Set<string>()
    : getAffectedReloadScopes(hoveredScope, reloadableScopes);
  const reloadError = requestError || reloadAllError || dirt?.error;

  return (
    <WorkbenchStickyCard className="sticky bottom-0 z-20 mt-auto ml-3" open={tabOutOfDate || hasReloadDirt || showUpdate}>
      <div data-reload-necessary="true">
        {showUpdate ? (
          <div className={hasReloadDirt || tabOutOfDate ? `mb-2 border-b pb-2 ${DIVIDER}` : ""}>
            <WorkbenchUpdateAvailable appRuntime={appRuntime} daemonRuntime={daemonRuntime} onAskAgent={onAskAgent} />
          </div>
        ) : null}
        {hasReloadDirt ? (
          <div
            className={`
              grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2
              ${showReloadBody || tabOutOfDate ? `border-b pb-2 ${DIVIDER}` : ""}
            `}
          >
            <button
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand reload controls" : "Collapse reload controls"}
              className="inline-flex size-8 items-center justify-center rounded-full text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
              onClick={() => setReloadNecessaryOpen(collapsed)}
              title={collapsed ? "Expand reload controls" : "Collapse reload controls"}
              type="button"
            >
              <ChevronIcon className={`transition-transform ${collapsed ? "rotate-180" : ""}`} size={16} />
            </button>
            <div className="min-w-0">
              <p className="m-0 truncate font-semibold text-text">Reload necessary</p>
              {interrupted && allBusy ? (
                <p className="m-0 truncate text-[0.74rem] leading-4 text-fg/muted">Reconnecting…</p>
              ) : null}
            </div>
            {reloadableScopes.length || reloadAllRunning ? <PrimaryButton
              className="!px-3 !py-1.5 !text-[0.76rem] [&>span:first-of-type]:!inset-[3px]"
              disabled={allBusy || interrupted}
              holdToConfirmMs={getReloadAllHoldMs(reloadableScopes)}
              onClick={() => void reloadAll()}
              onPointerEnter={() => setHoveredScope("all")}
              onPointerLeave={() => setHoveredScope(null)}
              pendingHalo={allBusy}
              tone={reloadableScopes.some(({ destructive }) => destructive) ? "danger" : "default"}
            >
              Reload all
            </PrimaryButton> : null}
          </div>
        ) : null}
        {showReloadBody ? (
          <div className="mt-2 space-y-1.5">
            {reloadableScopes.map((scope) => {
              const busy = pending.has(scope.scope) || requesting.includes(scope.scope);
              const restartRequired = scope.scope === "client:process" || scope.scope === "client:install";
              return (
                <div className="flex items-center justify-between gap-2" key={scope.scope}>
                  <p className="m-0 min-w-0 truncate text-[0.8rem] font-medium text-text" title={scope.description}>{scope.scope}</p>
                  <PrimaryButton
                    className={`
                      !shrink-0 !px-3 !py-1.5 !text-[0.76rem] [&>span:first-of-type]:!inset-[3px]
                      ${affectedScopes.has(scope.scope)
                        ? `[&>span:first-of-type]:!ring-2 ${scope.destructive
                          ? "[&>span:first-of-type]:!ring-danger"
                          : "[&>span:first-of-type]:!ring-accent"}`
                        : ""}
                    `}
                    disabled={allBusy || interrupted}
                    holdToConfirmMs={getReloadScopeHoldMs(scope)}
                    onClick={() => void reloadScope(scope)}
                    onPointerEnter={() => setHoveredScope(scope.scope)}
                    onPointerLeave={() => setHoveredScope(null)}
                    pendingHalo={busy}
                    tone={scope.destructive ? "danger" : "default"}
                  >
                    {restartRequired ? "Restart" : "Reload"}
                  </PrimaryButton>
                </div>
              );
            })}
            {reloadError && !interrupted ? (
              <p className="m-0 text-[0.74rem] leading-4 text-danger">{reloadError}</p>
            ) : null}
          </div>
        ) : null}
        {tabOutOfDate ? (
          <div
            className={`
              flex items-center justify-between gap-2
              ${showReloadBody ? `mt-2 border-t pt-2 ${DIVIDER}` : hasReloadDirt ? "mt-2" : ""}
            `}
            data-tab-out-of-date="true"
          >
            <p className="m-0 min-w-0 pl-1 text-[0.8rem] font-semibold text-text">
              This tab is out of date
            </p>
            <PrimaryButton
              className="!shrink-0 !px-3 !py-1.5 !text-[0.76rem] [&>span:first-of-type]:!inset-[3px]"
              onClick={() => window.location.reload()}
            >
              Refresh
            </PrimaryButton>
          </div>
        ) : null}
      </div>
    </WorkbenchStickyCard>
  );
}

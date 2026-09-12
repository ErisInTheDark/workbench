/*
 * Exports:
 * - default ReloadNecessary: render runtime reload controls with a separate stale-tab footer action.
 */
"use client";

import { useState, useSyncExternalStore } from "react";

import type { WorkbenchAppRuntimeStore, WorkbenchOrchestratorRuntimeStore, WorkbenchReloadDirtScope } from "workbench-shared/types";
import ChevronIcon from "./ChevronIcon";
import PrimaryButton from "./PrimaryButton";
import {
  getReloadAllHoldMs,
  getAffectedReloadScopes,
  getReloadScopeHoldMs,
  mergeReloadDirt,
  partitionReloadScopes,
} from "./reload-necessary-state";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";

const EMPTY_SUBSCRIBE = () => () => undefined;

export default function ReloadNecessary ({
  appRuntime,
  orchestratorRuntime,
}: {
  appRuntime: WorkbenchAppRuntimeStore | null;
  orchestratorRuntime: WorkbenchOrchestratorRuntimeStore | null;
}) {
  const [hoveredScope, setHoveredScope] = useState<string | "all" | null>(null);
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState<string[]>([]);
  const { preferences, setReloadNecessaryOpen } = useWorkbenchSidebarPreferences();
  const collapsed = !preferences.reloadNecessaryOpen;
  const orchestratorDirt = useSyncExternalStore(
    orchestratorRuntime?.subscribe ?? EMPTY_SUBSCRIBE,
    orchestratorRuntime?.getSnapshot ?? (() => null),
    () => null,
  );
  const appDirt = useSyncExternalStore(
    appRuntime?.subscribe ?? EMPTY_SUBSCRIBE,
    appRuntime?.getSnapshot ?? (() => null),
    () => null,
  );
  const dirt = mergeReloadDirt(appDirt, orchestratorDirt);
  const tabOutOfDate = appDirt?.tabOutOfDate ?? false;
  const hasReloadDirt = Boolean(dirt && (dirt.dirtyScopes.length || dirt.error));
  const showReloadBody = hasReloadDirt && !collapsed;

  if (!tabOutOfDate && !hasReloadDirt) return null;

  const pending = new Set(dirt?.pendingScopes ?? []);
  const reloadableScopes = dirt?.dirtyScopes ?? [];
  const reload = async (scopes: readonly WorkbenchReloadDirtScope[]) => {
    const selected = scopes.map(({ scope }) => scope);
    setRequestError("");
    setRequesting(selected);
    try {
      const owners = partitionReloadScopes(selected);
      await Promise.all([
        owners.client.length
          ? appRuntime?.reloadScopes(owners.client) ?? Promise.reject(new Error("Workbench app reload controls are not ready."))
          : undefined,
        owners.server.length
          ? orchestratorRuntime?.reloadScopes(owners.server) ?? Promise.reject(new Error("Workbench daemon reload controls are not ready."))
          : undefined,
      ]);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unable to reload the selected scopes.");
    } finally {
      setRequesting([]);
    }
  };
  const allBusy = Boolean(dirt?.pendingScopes.length || requesting.length);
  const affectedScopes = getAffectedReloadScopes(hoveredScope, reloadableScopes);

  return (
    <section className="sticky bottom-0 z-20 mt-auto ml-3">
      <div
        className="rounded-[1.15rem] border border-[color-mix(in_srgb,var(--text)_20%,transparent)] bg-[color:color-mix(in_srgb,var(--text)_4%,var(--shell-fade-bg))] [--fg-bg:color-mix(in_srgb,var(--text)_4%,var(--shell-fade-bg))] p-2.5 backdrop-blur-md"
        data-reload-necessary="true"
      >
        <div
          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 ${showReloadBody || tabOutOfDate ? "border-b border-[color-mix(in_srgb,var(--text)_12%,transparent)] pb-2" : ""
            }`}
        >
          {hasReloadDirt ? (
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
          ) : <span aria-hidden="true" className="size-8" />}
          <p className="m-0 min-w-0 truncate font-semibold text-text">
            Reload necessary
          </p>
          {reloadableScopes.length ? <PrimaryButton
            className="!px-3 !py-1 !text-[0.74rem] [&>span:first-of-type]:!inset-[3px]"
            disabled={allBusy}
            holdToConfirmMs={getReloadAllHoldMs(reloadableScopes)}
            onClick={() => void reload(reloadableScopes)}
            onPointerEnter={() => setHoveredScope("all")}
            onPointerLeave={() => setHoveredScope(null)}
            pendingHalo={allBusy}
            tone={reloadableScopes.some(({ destructive }) => destructive) ? "danger" : "default"}
          >
            Reload all
          </PrimaryButton> : null}
        </div>
        {showReloadBody ? (
          <div className="mt-2 space-y-1.5">
            {reloadableScopes.map((scope) => {
              const busy = pending.has(scope.scope) || requesting.includes(scope.scope);
              const restartRequired = scope.scope === "client:process";
              return (
                <div className="flex items-center justify-between gap-2" key={scope.scope}>
                  <p className="m-0 min-w-0 truncate text-[0.8rem] font-medium text-text">{scope.scope}</p>
                  <PrimaryButton
                    className={`!shrink-0 !px-3 !py-1 !text-[0.74rem] [&>span:first-of-type]:!inset-[3px] ${
                      affectedScopes.has(scope.scope)
                        ? "[&>span:first-of-type]:!ring-2 [&>span:first-of-type]:!ring-accent"
                        : ""
                    }`}
                    disabled={busy}
                    holdToConfirmMs={getReloadScopeHoldMs(scope)}
                    onClick={() => void reload([scope])}
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
            {requestError || dirt?.error ? (
              <p className="m-0 text-[0.74rem] leading-4 text-danger">{requestError || dirt?.error}</p>
            ) : null}
          </div>
        ) : null}
        {tabOutOfDate ? (
          <div
            className={`flex items-center justify-between gap-2 ${showReloadBody ? "mt-2 border-t border-[color-mix(in_srgb,var(--text)_12%,transparent)] pt-2" : "mt-2"}`}
            data-tab-out-of-date="true"
          >
            <p className="m-0 min-w-0 pl-1 text-[0.8rem] font-semibold text-text">
              This tab is out of date
            </p>
            <PrimaryButton
              className="!shrink-0 !px-3 !py-1 !text-[0.74rem] [&>span:first-of-type]:!inset-[3px]"
              onClick={() => window.location.reload()}
            >
              Refresh
            </PrimaryButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

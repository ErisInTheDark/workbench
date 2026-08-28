/*
 * Exports:
 * - default ReloadNecessary: render pushed reload dirt as a collapsible, user-confirmed sidebar action surface. Keywords: reload, dirt, sidebar, hold.
 */
"use client";

import { useState, useSyncExternalStore } from "react";

import type { OrchestratorReloadResponse, OrchestratorReloadScope, WorkbenchReloadDirtScope, WorkbenchThreadSidebarStore } from "../../lib/types";
import ChevronIcon from "./ChevronIcon";
import PrimaryButton from "./PrimaryButton";
import {
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
} from "./reload-necessary-state";
import { useWorkbenchSidebarPreferences } from "./workbench-sidebar-preferences-context";

const EMPTY_SUBSCRIBE = () => () => undefined;

export default function ReloadNecessary({
  reloadScopes,
  store,
}: {
  reloadScopes: ((scopes: OrchestratorReloadScope[]) => Promise<OrchestratorReloadResponse>) | null;
  store: WorkbenchThreadSidebarStore | null;
}) {
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState<string[]>([]);
  const { preferences, setReloadNecessaryOpen } = useWorkbenchSidebarPreferences();
  const collapsed = !preferences.reloadNecessaryOpen;
  const snapshot = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, store?.getSnapshot ?? (() => null), () => null);
  const dirt = snapshot?.reloadDirt;

  if (!dirt?.dirtyScopes.length) return null;

  const pending = new Set(dirt.pendingScopes);
  const reload = async (scopes: readonly WorkbenchReloadDirtScope[]) => {
    const selected = scopes.map(({ scope }) => scope);
    setRequestError("");
    setRequesting(selected);
    try {
      if (!reloadScopes) throw new Error("Workbench reload controls are not ready.");
      await reloadScopes(selected);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unable to reload the selected scopes.");
    } finally {
      setRequesting([]);
    }
  };
  const allBusy = Boolean(dirt.pendingScopes.length || requesting.length);

  return (
    <section
      className="sticky bottom-0 z-20 mt-auto"
      data-reload-necessary="true"
    >
      <div className="rounded-[1.15rem] border border-[color-mix(in_srgb,var(--text)_20%,transparent)] bg-[color:color-mix(in_srgb,var(--text)_4%,var(--shell-fade-bg))] p-2.5 backdrop-blur-md">
        <div
          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 ${
            collapsed ? "" : "border-b border-[color-mix(in_srgb,var(--text)_12%,transparent)] pb-2"
          }`}
        >
          <button
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand reload controls" : "Collapse reload controls"}
            className="inline-flex size-8 items-center justify-center rounded-full text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
            onClick={() => setReloadNecessaryOpen(collapsed)}
            title={collapsed ? "Expand reload controls" : "Collapse reload controls"}
            type="button"
          >
            <ChevronIcon className={`size-4 transition-transform ${collapsed ? "-rotate-90" : "rotate-90"}`} />
          </button>
          <p className="m-0 min-w-0 truncate font-semibold text-text">
            Reload necessary
          </p>
          <PrimaryButton
            className="!px-3 !py-1 !text-[0.74rem] [&>span:first-of-type]:!inset-[3px]"
            disabled={allBusy}
            holdToConfirmMs={getReloadAllHoldMs(dirt.dirtyScopes)}
            onClick={() => void reload(dirt.dirtyScopes)}
            pendingHalo={allBusy}
            tone={dirt.dirtyScopes.some(({ destructive }) => destructive) ? "danger" : "default"}
          >
            Reload all
          </PrimaryButton>
        </div>
        {!collapsed ? (
          <div className="mt-2 space-y-1.5">
            {dirt.dirtyScopes.map((scope) => {
              const busy = pending.has(scope.scope) || requesting.includes(scope.scope);
              return (
                <div className="flex items-center justify-between gap-2" key={scope.scope}>
                  <p className="m-0 min-w-0 truncate text-[0.8rem] font-medium text-text">{scope.scope}</p>
                  <PrimaryButton
                    className="!shrink-0 !px-3 !py-1 !text-[0.74rem] [&>span:first-of-type]:!inset-[3px]"
                    disabled={busy}
                    holdToConfirmMs={getReloadScopeHoldMs(scope)}
                    onClick={() => void reload([scope])}
                    pendingHalo={busy}
                    tone={scope.destructive ? "danger" : "default"}
                  >
                    Reload
                  </PrimaryButton>
                </div>
              );
            })}
            {requestError || dirt.error ? (
              <p className="m-0 text-[0.74rem] leading-4 text-danger">{requestError || dirt.error}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

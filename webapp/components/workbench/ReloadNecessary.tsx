/*
 * Exports:
 * - default ReloadNecessary: render pushed reload dirt as a collapsible, user-confirmed sidebar action surface. Keywords: reload, dirt, sidebar, hold.
 */
"use client";

import { useState, useSyncExternalStore } from "react";

import type { OrchestratorReloadResponse, WorkbenchReloadDirtScope, WorkbenchThreadSidebarStore } from "../../lib/types";
import PrimaryButton from "./PrimaryButton";
import { getReloadAllHoldMs, getReloadScopeHoldMs } from "./reload-necessary-state";

const EMPTY_SUBSCRIBE = () => () => undefined;

export default function ReloadNecessary({ store }: { store: WorkbenchThreadSidebarStore | null }) {
  const [collapsed, setCollapsed] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState<string[]>([]);
  const snapshot = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, store?.getSnapshot ?? (() => null), () => null);
  const dirt = snapshot?.reloadDirt;
  if (!dirt?.dirtyScopes.length) return null;

  const pending = new Set(dirt.pendingScopes);
  const reload = async (scopes: readonly WorkbenchReloadDirtScope[]) => {
    const selected = scopes.map(({ scope }) => scope);
    setRequestError("");
    setRequesting(selected);
    try {
      const response = await fetch("/api/orchestrator/reload", {
        body: JSON.stringify({ scopes: selected }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json() as OrchestratorReloadResponse | { error?: string };
      if (!response.ok || !("ok" in payload && payload.ok)) {
        throw new Error("error" in payload && typeof payload.error === "string" ? payload.error : "Unable to reload the selected scopes.");
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unable to reload the selected scopes.");
    } finally {
      setRequesting([]);
    }
  };

  return (
    <section className="relative z-20 -mx-1 shrink-0 bg-[linear-gradient(to_top,var(--shell-fade-bg)_76%,transparent)] px-1 pb-1 pt-5" data-reload-necessary="true">
      <div className="rounded-2xl bg-[color-mix(in_srgb,var(--shell-fade-bg)_92%,var(--text)_8%)] p-2 shadow-[0_10px_35px_color-mix(in_srgb,black_18%,transparent)]">
        <button
          aria-expanded={!collapsed}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setCollapsed((value) => !value)}
          type="button"
        >
          <span className="font-semibold text-text">Reload necessary</span>
          <span aria-hidden="true" className={`text-muted transition-transform ${collapsed ? "-rotate-90" : "rotate-90"}`}>›</span>
        </button>
        {!collapsed ? (
          <div className="space-y-2 px-2 pb-1 pt-2">
            {dirt.dirtyScopes.map((scope) => {
              const busy = pending.has(scope.scope) || requesting.includes(scope.scope);
              return (
                <div className="flex items-center justify-between gap-2" key={scope.scope}>
                  <div className="min-w-0">
                    <p className="truncate text-[0.8rem] font-medium text-text">{scope.scope}</p>
                    <p className="line-clamp-2 text-[0.72rem] leading-4 text-muted">{scope.description}</p>
                  </div>
                  <PrimaryButton
                    className="!shrink-0 !px-3 !py-1.5 !text-[0.74rem]"
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
            <div className="flex justify-end pt-1">
              <PrimaryButton
                className="!px-3 !py-1.5 !text-[0.74rem]"
                disabled={Boolean(dirt.pendingScopes.length || requesting.length)}
                holdToConfirmMs={getReloadAllHoldMs(dirt.dirtyScopes)}
                onClick={() => void reload(dirt.dirtyScopes)}
                pendingHalo={Boolean(dirt.pendingScopes.length || requesting.length)}
                tone={dirt.dirtyScopes.some(({ destructive }) => destructive) ? "danger" : "default"}
              >
                Reload all
              </PrimaryButton>
            </div>
            {requestError || dirt.error ? <p className="text-[0.74rem] leading-4 text-danger">{requestError || dirt.error}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

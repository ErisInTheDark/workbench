/*
 * Exports:
 * - default ReloadNecessary: render pushed reload dirt as a collapsible, user-confirmed sidebar action surface. Keywords: reload, dirt, sidebar, hold.
 */
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { OrchestratorReloadResponse, WorkbenchReloadDirtScope, WorkbenchThreadSidebarStore } from "../../lib/types";
import ChevronIcon from "./ChevronIcon";
import PrimaryButton from "./PrimaryButton";
import {
  getReloadAllHoldMs,
  getReloadScopeHoldMs,
  waitForReloadCompletion,
} from "./reload-necessary-state";

const EMPTY_SUBSCRIBE = () => () => undefined;

export default function ReloadNecessary({
  order,
  store,
}: {
  order?: number;
  store: WorkbenchThreadSidebarStore | null;
}) {
  const activeReloadRef = useRef<AbortController | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState<string[]>([]);
  const snapshot = useSyncExternalStore(store?.subscribe ?? EMPTY_SUBSCRIBE, store?.getSnapshot ?? (() => null), () => null);
  const dirt = snapshot?.reloadDirt;

  useEffect(() => () => {
    activeReloadRef.current?.abort(new Error("Reload status wait was cancelled."));
    activeReloadRef.current = null;
  }, []);

  if (!dirt?.dirtyScopes.length) return null;

  const pending = new Set(dirt.pendingScopes);
  const reload = async (scopes: readonly WorkbenchReloadDirtScope[]) => {
    const controller = new AbortController();
    activeReloadRef.current?.abort(new Error("Reload status wait was replaced."));
    activeReloadRef.current = controller;
    const selected = scopes.map(({ scope }) => scope);
    setRequestError("");
    setRequesting(selected);
    try {
      const response = await fetch("/api/orchestrator/reload", {
        body: JSON.stringify({ scopes: selected }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      const payload = await response.json() as OrchestratorReloadResponse | { error?: string };
      if (!response.ok || !("ok" in payload && payload.ok)) {
        throw new Error("error" in payload && typeof payload.error === "string" ? payload.error : "Unable to reload the selected scopes.");
      }
      const terminal = await waitForReloadCompletion({
        admission: payload,
        readStatus: async (signal) => {
          const statusResponse = await fetch("/api/orchestrator/reload", {
            cache: "no-store",
            method: "GET",
            signal,
          });
          const status = await statusResponse.json() as OrchestratorReloadResponse | { error?: string };
          if (!statusResponse.ok || !("ok" in status)) {
            throw new Error("error" in status && typeof status.error === "string" ? status.error : "Unable to read reload status.");
          }
          return status;
        },
        signal: controller.signal,
      });
      if (terminal.state === "failed") {
        throw new Error(terminal.error || "Unable to reload the selected scopes.");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setRequestError(error instanceof Error ? error.message : "Unable to reload the selected scopes.");
      }
    } finally {
      if (activeReloadRef.current === controller) {
        activeReloadRef.current = null;
        setRequesting([]);
      }
    }
  };
  const allBusy = Boolean(dirt.pendingScopes.length || requesting.length);

  return (
    <section
      className="sticky bottom-0 z-20 mt-auto"
      data-reload-necessary="true"
      style={order === undefined ? undefined : { order }}
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
            onClick={() => setCollapsed((current) => !current)}
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

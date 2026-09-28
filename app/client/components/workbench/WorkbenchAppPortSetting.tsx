/*
 * Default export:
 * - WorkbenchAppPortSetting: render app-port facts and perform the connection-changing handoff.
 */
"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  createWorkbenchAppPortRedirectUrl,
  readWorkbenchAppPort,
  updateWorkbenchAppPort,
  type WorkbenchAppPortClientSnapshot,
} from "../../workbench/app/workbench-app-port-client";
import { readWorkbenchBrowserStateTransferId } from "../../workbench/state/workbench-browser-state-identity";
import WorkbenchTextField from "./WorkbenchTextField";
import PrimaryButton from "./PrimaryButton";
import { useWorkbenchAppRpc } from "../../workbench/app/WorkbenchAppRpcContext";

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to read the Workbench app port.").slice(0, 500);
}

function validPort(value: string) {
  if (!/^\d+$/u.test(value)) return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function sourceDescription(snapshot: WorkbenchAppPortClientSnapshot | null) {
  switch (snapshot?.source) {
    case "environment": return "Controlled by WORKBENCH_APP_PORT. Remove that environment override and restart Workbench to edit this setting.";
    case "random": return "Workbench chose this port for the current launch. Apply to save it or choose another available port.";
    case "setting": return "Workbench will reuse this port on future launches.";
    default: return "Choose the local port used by the Workbench app.";
  }
}

export default function WorkbenchAppPortSetting({ inline = false }: { inline?: boolean }) {
  const rpc = useWorkbenchAppRpc();
  const [snapshot, setSnapshot] = useState<WorkbenchAppPortClientSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const port = validPort(draft);
  const disabled = isLoading || isApplying || snapshot?.editable !== true;

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void readWorkbenchAppPort(rpc)
      .then((nextSnapshot) => {
        if (cancelled || current !== generation) return;
        setSnapshot(nextSnapshot);
        if (!loaded) setDraft(String(nextSnapshot.currentPort));
        loaded = true;
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!cancelled && current === generation) setError(boundedError(loadError));
      })
      .finally(() => {
        if (!cancelled && current === generation) setIsLoading(false);
      });
    };
    const stop = rpc?.onOpen(load);
    if (!rpc || rpc.connected) load();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [rpc]);

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (port === null || disabled) return;
    setIsApplying(true);
    setError("");
    try {
      const nextSnapshot = await updateWorkbenchAppPort(port);
      setSnapshot(nextSnapshot);
      setDraft(String(nextSnapshot.currentPort));
      window.location.assign(createWorkbenchAppPortRedirectUrl(
        window.location.href,
        nextSnapshot.appOrigin,
        readWorkbenchBrowserStateTransferId(snapshot),
        nextSnapshot.stableOrigin ?? (
          window.location.protocol === "https:"
          || Number(window.location.port || "80") !== snapshot?.currentPort
            ? window.location.origin
            : null
        ),
      ));
    } catch (applyError) {
      setError(boundedError(applyError));
      setIsApplying(false);
    }
  }

  return (
    <section className="space-y-3 rounded-[0.85rem] py-1">
      {!inline ? <div className="min-w-0">
        <h3 className="m-0 text-[0.98rem] font-semibold leading-tight text-text">App port</h3>
        <p className="mt-1 mb-0 text-[0.82rem] leading-6 text-fg/muted">{sourceDescription(snapshot)}</p>
      </div> : null}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { void apply(event); }}>
        <label className={inline ? "w-24 text-sm text-text" : "sr-only"} htmlFor="workbench-app-port">{inline ? "Port" : "App port"}</label>
        <WorkbenchTextField
          id="workbench-app-port"
          aria-describedby={error ? "workbench-app-port-error" : undefined}
          aria-invalid={Boolean(error) || port === null || undefined}
          autoComplete="off"
          className="w-36"
          disabled={disabled}
          inputMode="numeric"
          maxLength={5}
          pattern="[0-9]*"
          value={draft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (error) setError("");
          }}
        />
        <PrimaryButton
          type="submit"
          pendingHalo={isApplying}
          disabled={disabled || port === null}
        >
          {isApplying ? "Applying..." : "Apply"}
        </PrimaryButton>
      </form>
      {inline && snapshot?.source === "environment" ? <p className="m-0 text-sm text-fg/muted">{sourceDescription(snapshot)}</p> : null}
      {error ? (
        <p id="workbench-app-port-error" className="m-0 text-[0.78rem] leading-5 text-danger" role="alert">{error}</p>
      ) : null}
    </section>
  );
}

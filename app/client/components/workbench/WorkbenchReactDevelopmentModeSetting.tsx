/*
 * Default export:
 * - WorkbenchReactDevelopmentModeSetting: render and persist the app-wide React runtime mode with restart status.
 */
"use client";

import { useEffect, useState } from "react";

import {
  readWorkbenchAppSettings,
  updateWorkbenchAppSettings,
} from "../../workbench/app/workbench-app-settings-client";
import { WorkbenchOptionCard } from "./WorkbenchOptionCards";
import { useWorkbenchAppRpc } from "../../workbench/app/WorkbenchAppRpcContext";

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : "Unable to read Workbench app settings.").slice(0, 500);
}

export default function WorkbenchReactDevelopmentModeSetting() {
  const rpc = useWorkbenchAppRpc();
  const [applied, setApplied] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const [isAvailable, setIsAvailable] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const restartRequired = applied !== requested;

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void readWorkbenchAppSettings(rpc)
      .then((snapshot) => {
        if (cancelled || current !== generation) return;
        setError("");
        setIsAvailable(true);
        setApplied(snapshot.appliedReactDevelopmentMode);
        setRequested(snapshot.requestedReactDevelopmentMode);
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

  const description = !isAvailable
    ? "Waiting for app settings."
    : restartRequired
      ? `${requested ? "Development" : "Production"} React is saved. Restart Workbench to apply it.`
      : requested
        ? "React's development runtime is active. This adds significant render overhead, and React Scan may also run."
        : "Use React's development runtime and allow React Scan unless the environment disables it. This adds significant render overhead.";

  async function update() {
    if (isLoading || isSaving || !isAvailable) return;
    setIsSaving(true);
    setError("");
    try {
      const snapshot = await updateWorkbenchAppSettings(!requested, rpc);
      setApplied(snapshot.appliedReactDevelopmentMode);
      setRequested(snapshot.requestedReactDevelopmentMode);
    } catch (updateError) {
      setError(boundedError(updateError));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="space-y-2 rounded-[0.85rem] py-1">
      <WorkbenchOptionCard
        description={description}
        disabled={isLoading || isSaving || !isAvailable}
        isChecked={requested}
        isSingleChoice={false}
        label="React development mode"
        onClick={() => { void update(); }}
      />
      {error ? (
        <p className="m-0 text-[0.78rem] leading-5 text-danger" role="alert">{error}</p>
      ) : null}
    </section>
  );
}

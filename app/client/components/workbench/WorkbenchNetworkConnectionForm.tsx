/*
 * Default export:
 * - WorkbenchNetworkConnectionForm: display-only connection drafts and explicit safe Apply/Reset.
 */
"use client";
import { useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkSettings } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import WorkbenchModeRow from "./WorkbenchModeRow";
import WorkbenchTextField from "./WorkbenchTextField";
import PrimaryButton from "./PrimaryButton";
import WorkbenchIconButton from "./WorkbenchIconButton";
import { ExternalLinkIcon, HomeIcon, LockIcon, SaveIcon, ResetIcon } from "./workbench-icons";

const modes = [
  { value: "localhost", label: "localhost", ariaLabel: "Localhost only", icon: <HomeIcon className="size-4" /> },
  { value: "tailnet-ip", label: "tailnet ip", ariaLabel: "Tailnet IP", icon: <ExternalLinkIcon className="size-4" /> },
  { value: "tailnet-service", label: "tailnet service", ariaLabel: "Tailnet service with HTTPS", icon: <LockIcon className="size-4" /> },
] as const;
type Draft = { mode: WorkbenchNetworkSettings["mode"]; localPort: string; tailnetPort: string; label: string };

export default function WorkbenchNetworkConnectionForm() {
  const network = useWorkbenchNetwork();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const snapshot = network.snapshot;
  if (!snapshot) return null;
  const suggested = (snapshot.runtime.host?.hostname ?? "").toLowerCase().split(".")[0]!.replace(/[^a-z0-9-]/gu, "-").slice(0, 60).replace(/^-+|-+$/gu, "");
  const saved: Draft = {
    mode: workbenchNetworkMode(snapshot.configuration),
    localPort: String(snapshot.localPort?.currentPort ?? ""),
    tailnetPort: String(snapshot.configuration.hostServe.port),
    label: snapshot.configuration.privateAccess?.label ?? suggested,
  };
  const value = draft ?? saved;
  const busy = working || snapshot.busy;
  const disabled = busy || !!snapshot.change || !snapshot.capabilities?.manageApp || !snapshot.capabilities.settingsApply || !snapshot.localPort;
  const dirty = draft !== null && (Object.keys(saved) as (keyof Draft)[]).some(key => draft[key] !== saved[key]);
  function edit(next: Partial<Draft>) { setDraft({ ...value, ...next }); }
  async function run(action: () => Promise<void>) {
    setWorking(true);
    setError("");
    try { await action(); setDraft(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Connection settings could not be saved."); }
    finally { setWorking(false); }
  }
  return <form className="flex flex-col gap-4" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    void run(() => network.client.changeSettings({
      mode: value.mode, localPort: Number(value.localPort), tailnetPort: Number(value.tailnetPort),
      ...(value.mode === "tailnet-service" ? { label: value.label } : {}),
    }));
  }}>
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-text">Connection type</span>
      <WorkbenchModeRow ariaLabel="Connection type" options={modes.filter(mode => mode.value !== "localhost" || snapshot.capabilities?.trustHost)}
        value={value.mode} disabled={disabled} onChange={mode => edit({ mode })} />
    </div>
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <label className="flex items-center gap-3 text-sm text-text" htmlFor="workbench-local-port">Local port
        <WorkbenchTextField id="workbench-local-port" type="number" min={1} max={65535} required value={value.localPort}
          className="w-28" disabled={disabled || !snapshot.localPort?.editable} onChange={event => edit({ localPort: event.currentTarget.value })} />
      </label>
      <label className="flex items-center gap-3 text-sm text-fg/muted" htmlFor="workbench-tailnet-port">Tailnet port
        <WorkbenchTextField id="workbench-tailnet-port" type="number" min={1} max={65535} required value={value.tailnetPort}
          className="w-28" disabled={disabled} onChange={event => edit({ tailnetPort: event.currentTarget.value })} />
      </label>
    </div>
    {value.mode === "tailnet-service" ? <label className="flex flex-wrap items-center gap-3 text-sm text-text" htmlFor="workbench-machine-name">Machine name
      <WorkbenchTextField id="workbench-machine-name" value={value.label} required maxLength={60} pattern="[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?"
        autoComplete="off" className="w-52 max-w-full" disabled={disabled} onChange={event => edit({ label: event.currentTarget.value })} />
      <span className="text-xs text-fg/muted">{value.label || "<machine>"}.wb.inthedark.boo</span>
    </label> : null}
    {!snapshot.localPort?.editable && snapshot.localPort ? <p className="m-0 text-xs text-fg/muted">Local port is controlled by WORKBENCH_APP_PORT.</p> : null}
    {!snapshot.capabilities?.settingsApply ? <p role="status" className="m-0 text-sm text-fg/muted">Reload client:network, then refresh to use the updated connection controls.</p> : null}
    <div className="flex items-center gap-2">
      <WorkbenchIconButton type="submit" label="Apply connection settings" disabled={disabled || !dirty}><SaveIcon className="size-4" /></WorkbenchIconButton>
      <WorkbenchIconButton label="Reset connection changes" disabled={busy || !draft} onClick={() => { setDraft(null); setError(""); }}><ResetIcon className="size-4" /></WorkbenchIconButton>
    </div>
    {snapshot.change ? <div className="flex flex-col gap-2 text-sm">
      <p className="m-0 text-fg/muted">{snapshot.change.phase === "failed"
        ? "Some settings may already be saved. This address remains available; retry to finish applying."
        : "A connection change is pending. The previous address stays available until this browser arrives."}</p>
      {network.handoff ? <div className="flex gap-2">
        <PrimaryButton type="button" disabled={busy} onClick={() => { void run(() => network.client.finishSettings(network.handoff?.returning)); }}>{network.handoff.returning ? "Finish cancelling" : "Finish applying"}</PrimaryButton>
        {snapshot.change.phase !== "failed" ? <PrimaryButton type="button" disabled={busy} onClick={() => { void run(() => network.client.finishSettings(true)); }}>Cancel change</PrimaryButton> : null}
      </div> : <PrimaryButton type="button" disabled={busy} onClick={() => { void run(() => network.client.resumeSettings()); }}>Resume connection change</PrimaryButton>}
    </div> : null}
    {error ? <p role="alert" className="m-0 text-sm text-danger">{error}</p> : null}
  </form>;
}

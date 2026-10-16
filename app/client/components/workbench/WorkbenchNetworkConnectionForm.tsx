/*
 * Default export:
 * - WorkbenchNetworkConnectionForm: connection settings card with drafts and explicit safe Apply/Reset once edited.
 */
"use client";
import { useState, type ReactNode } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkSettings } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import RadioRow from "../ui/RadioRow";
import WorkbenchTextField from "./WorkbenchTextField";
import PrimaryButton from "../ui/PrimaryButton";
import IconButton from "../ui/IconButton";
import SettingsCard, { SettingsCardRow } from "../ui/SettingsCard";
import { ExternalLinkIcon, HomeIcon, LockIcon, SaveIcon, ResetIcon } from "./workbench-icons";

const modes = [
  { value: "localhost", label: "Localhost", ariaLabel: "Localhost only", icon: <HomeIcon className="size-4" /> },
  { value: "tailnet-ip", label: "Tailnet IP", ariaLabel: "Tailnet IP", icon: <ExternalLinkIcon className="size-4" /> },
  { value: "tailnet-service", label: "Tailnet service", ariaLabel: "Tailnet service with HTTPS", icon: <LockIcon className="size-4" /> },
] as const;
type Draft = { mode: WorkbenchNetworkSettings["mode"]; localPort: string; tailnetPort: string; label: string };

export default function WorkbenchNetworkConnectionForm({ children }: {
  /** Status rows shown above the editable connection rows in the same card. */
  children?: ReactNode;
}) {
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
  return <form className="flex flex-col gap-3" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    void run(() => network.client.changeSettings({
      mode: value.mode, localPort: Number(value.localPort), tailnetPort: Number(value.tailnetPort),
      ...(value.mode === "tailnet-service" ? { label: value.label } : {}),
    }));
  }}>
    <SettingsCard label="This app">
      {children}
      <SettingsCardRow label="Reachable via">
        <RadioRow ariaLabel="Connection type" size="comfortable" options={modes.filter(mode => mode.value !== "localhost" || snapshot.capabilities?.trustHost)}
          value={value.mode} disabled={disabled} onChange={mode => edit({ mode })} />
      </SettingsCardRow>
      {value.mode === "tailnet-service" ? <SettingsCardRow label={<label htmlFor="workbench-machine-name">Private name</label>}>
        <span className="flex min-w-0 items-center">
          <WorkbenchTextField id="workbench-machine-name" variant="flush" value={value.label} required maxLength={60}
            pattern="[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?" autoComplete="off" spellCheck={false}
            className="field-sizing-content min-w-16 max-w-full pr-0.5" disabled={disabled} onChange={event => edit({ label: event.currentTarget.value })} />
          <span className="text-fg/muted">.wb.inthedark.boo</span>
        </span>
      </SettingsCardRow> : null}
      <SettingsCardRow label="Ports">
        <label className="flex items-center gap-2" htmlFor="workbench-local-port">Local
          <WorkbenchTextField id="workbench-local-port" variant="flush" type="number" min={1} max={65535} required value={value.localPort}
            className="w-20 tabular-nums" disabled={disabled || !snapshot.localPort?.editable}
            title={snapshot.localPort && !snapshot.localPort.editable ? "Set by WORKBENCH_APP_PORT" : undefined}
            onChange={event => edit({ localPort: event.currentTarget.value })} />
        </label>
        <label className={`flex items-center gap-2 ${value.mode === "localhost" ? "text-fg/muted" : ""}`} htmlFor="workbench-tailnet-port">Tailnet
          <WorkbenchTextField id="workbench-tailnet-port" variant="flush" type="number" min={1} max={65535} required value={value.tailnetPort}
            className="w-20 tabular-nums" disabled={disabled} onChange={event => edit({ tailnetPort: event.currentTarget.value })} />
        </label>
      </SettingsCardRow>
      {dirty ? <SettingsCardRow>
        <span className="flex-1 text-fg/muted">Unsaved connection changes</span>
        <IconButton type="submit" size="small" display="hover-border" label="Apply connection settings" disabled={disabled}><SaveIcon className="size-4" /></IconButton>
        <IconButton size="small" display="hover-border" label="Reset connection changes" disabled={busy} onClick={() => { setDraft(null); setError(""); }}><ResetIcon className="size-4" /></IconButton>
      </SettingsCardRow> : null}
    </SettingsCard>
    {!snapshot.capabilities?.settingsApply ? <p role="status" className="m-0 text-sm text-fg/muted">Reload client:network, then refresh to use the updated connection controls.</p> : null}
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

/*
 * Default export:
 * - WorkbenchNetworkSettings: render one connection mode, its address controls and contextual setup.
 */
"use client";
import { useEffect, useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkClient, { WorkbenchNetworkClientContext, useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import WorkbenchPrivateAccessWizard from "./WorkbenchPrivateAccessWizard";
import WorkbenchAppPortSetting from "./WorkbenchAppPortSetting";
import WorkbenchModeRow from "./WorkbenchModeRow";

const modes = [
  { value: "localhost", label: "localhost", ariaLabel: "Localhost only", icon: null },
  { value: "tailnet-ip", label: "tailnet ip", ariaLabel: "Tailnet IP", icon: null },
  { value: "tailnet-service", label: "tailnet service", ariaLabel: "Tailnet service with HTTPS", icon: null },
] as const;
const inputStyle = "h-10 min-w-0 rounded-xl bg-transparent px-3 font-mono text-sm text-text outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-40";
const buttonStyle = "h-10 rounded-xl px-3 text-sm text-text hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40";

function NetworkSettingsContent() {
  const network = useWorkbenchNetwork();
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const snapshot = network.snapshot;
  if (!snapshot) return <p className="text-sm text-fg/muted" role="status">{network.error ?? "Loading networking..."}</p>;
  const mode = workbenchNetworkMode(snapshot.configuration);
  const privateAccess = snapshot.configuration.privateAccess;
  const status = snapshot.runtime;
  const busy = snapshot.busy || working;
  const port = portDraft ?? String(snapshot.configuration.hostServe.port);
  const suggested = (status.host?.hostname ?? "").toLowerCase().split(".")[0]!.replace(/[^a-z0-9-]/gu, "-").slice(0, 60).replace(/^-+|-+$/gu, "");
  const name = nameDraft ?? privateAccess?.label ?? suggested;
  const service = mode === "tailnet-service";
  const rawUrl = mode === "localhost" ? snapshot.localUrl : service ? status.privateAccess.url : status.hostServe.url;
  const appUrl = rawUrl ? new URL("/launch", rawUrl).href : null;
  const discoverable = mode !== "localhost" && status.daemonServe?.phase === "ready";
  const needsSetup = service && (privateAccess?.role === "unconfigured" || status.privateAccess.phase !== "ready");
  const pendingApproval = status.privateAccess.pending.length > 0;

  async function act(action: WorkbenchNetworkAction, applied?: () => void) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); applied?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Networking could not be updated."); }
    finally { setWorking(false); }
  }

  return (
    <section className="space-y-4 py-1">
      <h3 className="m-0 text-base font-semibold text-text">Networking</h3>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-text">Connection type</span>
        <WorkbenchModeRow ariaLabel="Connection type" options={modes} value={mode} disabled={busy}
          onChange={value => { void act({ action: "mode", mode: value }); }} />
      </div>
      {mode === "localhost" ? <WorkbenchAppPortSetting inline /> : (
        <form className="flex flex-wrap items-center gap-2"
          onSubmit={event => { event.preventDefault(); void act({ action: "tailnet-port", port: Number(port) }, () => setPortDraft(null)); }}>
          <label htmlFor="workbench-tailnet-port" className="w-24 text-sm text-text">Port</label>
          <input id="workbench-tailnet-port" type="number" min={1} max={65535} required value={port}
            onChange={event => setPortDraft(event.currentTarget.value)} disabled={busy || service}
            className={`${inputStyle} w-36`} />
          <button disabled={busy || service || !snapshot.executable.available} className={buttonStyle}>Apply</button>
        </form>
      )}
      {service ? (
        <form className="flex flex-wrap items-center gap-2"
          onSubmit={event => { event.preventDefault(); void act({ action: "machine-name", label: name }, () => setNameDraft(null)); }}>
          <label htmlFor="workbench-machine-name" className="w-24 text-sm text-text">Machine name</label>
          <input id="workbench-machine-name" value={name} onChange={event => setNameDraft(event.currentTarget.value)}
            required maxLength={60} pattern="[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?" autoComplete="off"
            disabled={busy} className={`${inputStyle} w-52 max-w-full`} />
          <button disabled={busy || !snapshot.executable.available} className={buttonStyle}>Apply</button>
        </form>
      ) : null}
      <div className="space-y-2 text-sm" role="status">
        <p className="m-0 text-text">Daemon availability on tailnet{" "}
          <span className={discoverable ? "text-success" : "text-fg/muted"}>
            {discoverable ? "discoverable" : mode === "localhost" ? "local only" : "not discoverable"}
          </span>
        </p>
        <p className="m-0 break-all text-text">App URL{" "}
          {appUrl ? <a className="text-accent underline" href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
            : <span className="text-fg/muted">not yet available</span>}
        </p>
        {mode !== "localhost" && status.daemonServe?.message ? <p className="m-0 text-fg/muted">{status.daemonServe.message}</p> : null}
        {mode !== "localhost" && status.hostServe.message ? <p className="m-0 text-fg/muted">{status.hostServe.message}</p> : null}
        {snapshot.configuration.rename ? <p className="m-0 text-fg/muted">Changing address to {snapshot.configuration.rename.to}.wb.inthedark.boo...</p> : null}
      </div>
      {[network.error, snapshot.failure, error].filter((message, index, all) => message && all.indexOf(message) === index)
        .map(message => <p key={message} role="alert" className="m-0 text-sm text-danger">{message}</p>)}
      {mode !== "localhost" && snapshot.executable.message ? <p role="alert" className="text-sm text-danger">{snapshot.executable.message}</p> : null}
      {privateAccess && (needsSetup || pendingApproval) ? <WorkbenchPrivateAccessWizard /> : privateAccess ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm text-fg/muted">Private address setup and management</summary>
          <WorkbenchPrivateAccessWizard />
        </details>
      ) : null}
      {busy ? <button className={buttonStyle}
        onClick={() => { void network.client.action({ action: "cancel" }).catch(() => setError("Cancellation could not be sent.")); }}>
        Cancel pending action
      </button> : null}
      {!privateAccess && service ? <p className="text-sm text-fg/muted">Apply a machine name to begin private HTTPS setup.</p> : null}
      {mode !== "localhost" && !privateAccess ? <button className={buttonStyle} disabled={busy}
        onClick={() => { void act({ action: "retry" }); }}>Retry networking</button> : null}
    </section>
  );
}

export default function WorkbenchNetworkSettings() {
  const [client, setClient] = useState<WorkbenchNetworkClient | null>(null);
  useEffect(() => {
    const owner = new WorkbenchNetworkClient();
    setClient(owner);
    void owner.start();
    return () => owner.close();
  }, []);
  if (!client) return null;
  return <WorkbenchNetworkClientContext.Provider value={client}><NetworkSettingsContent /></WorkbenchNetworkClientContext.Provider>;
}

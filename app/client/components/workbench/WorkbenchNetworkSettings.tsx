/*
 * Default export:
 * - WorkbenchNetworkSettings: render one connection mode, its address controls and contextual setup.
 */
"use client";
import { useEffect, useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkClient, { WorkbenchNetworkClientContext, useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import PrimaryButton from "./PrimaryButton";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchNetworkAccessSettings from "./WorkbenchNetworkAccessSettings";
import WorkbenchDaemonDiscovery from "./WorkbenchDaemonDiscovery";
import WorkbenchNetworkConnectionForm from "./WorkbenchNetworkConnectionForm";
import WorkbenchPrivateAccessWizard from "./WorkbenchPrivateAccessWizard";
import WorkbenchQrCode from "./WorkbenchQrCode";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { CheckIcon, ExternalLinkIcon } from "./workbench-icons";

function NetworkSettingsContent () {
  const network = useWorkbenchNetwork();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const snapshot = network.snapshot;
  if (!snapshot) return <p className="text-sm text-fg/muted" role="status">{network.error ?? "Loading networking..."}</p>;
  const mode = workbenchNetworkMode(snapshot.configuration);
  const privateAccess = snapshot.configuration.privateAccess;
  const status = snapshot.runtime;
  const busy = snapshot.busy || working;
  const editable = snapshot.capabilities?.manageApp ?? false;
  const service = mode === "tailnet-service";
  const httpsReady = service && status.privateAccess.phase === "ready" && network.verification.phase === "verified";
  const rawUrl = mode === "localhost" ? snapshot.localUrl
    : service ? httpsReady ? status.privateAccess.url : window.location.origin
      : status.hostServe.url ?? window.location.origin;
  const appUrl = rawUrl ? new URL("/launch", rawUrl).href : null;
  const tailnetUrl = status.hostServe.url ? new URL("/launch", status.hostServe.url).href : null;
  const discoverable = mode !== "localhost" && status.daemonServe?.phase === "ready";
  const connectionReady = mode === "localhost" || (service ? httpsReady : status.hostServe.phase === "ready");
  const connectionStatus = mode === "localhost" ? "Local only"
    : service ? httpsReady ? "HTTPS ready"
      : network.verification.phase === "checking" ? "Checking HTTPS..."
        : network.verification.phase === "failed" || status.privateAccess.phase === "failed" || !snapshot.executable.available
          ? "HTTPS needs attention" : "Setting up HTTPS"
      : status.hostServe.phase === "ready" ? "Tailnet ready" : "Tailnet connection needs attention";

  async function act (action: WorkbenchNetworkAction, applied?: () => void | Promise<void>) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); await applied?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Networking could not be updated."); }
    finally { setWorking(false); }
  }

  return (
    <section className="max-w-3xl space-y-5 py-1">
      <header className="flex flex-wrap items-center gap-5">
        <h3 className="m-0 text-base font-semibold text-text">Networking</h3>
        <p role="status" className="m-0 flex flex-wrap items-center gap-2 text-sm text-fg/muted">
          {connectionReady ? <CheckIcon className="size-4 text-success" /> : null}
          <span>{connectionStatus}{mode !== "localhost" ? discoverable ? " · discoverable" : " · not discoverable" : ""}</span>
        </p>
      </header>
      <div className="space-y-3 border-l-3 border-fg/10 pl-3">
        {mode !== "localhost" && status.daemonServe?.message ? <p className="m-0 text-fg/muted">{status.daemonServe.message}</p> : null}
        {mode !== "localhost" && status.hostServe.message ? <p className="m-0 text-fg/muted">{status.hostServe.message}</p> : null}
        {snapshot.configuration.rename ? <p className="m-0 text-fg/muted">Changing address to {snapshot.configuration.rename.to}.wb.inthedark.boo...</p> : null}
        {[network.error, snapshot.failure, error].filter((message, index, all) => message && all.indexOf(message) === index)
          .map(message => <p key={message} role="alert" className="m-0 text-danger">{message}</p>)}
        {mode !== "localhost" && snapshot.executable.message ? <p role="alert" className="m-0 text-danger">{snapshot.executable.message}</p> : null}
        {service && privateAccess ? <WorkbenchPrivateAccessWizard /> : null}
        {!privateAccess && service ? <p className="m-0 text-fg/muted">Apply a machine name to begin private HTTPS setup.</p> : null}
        {mode !== "localhost" && !privateAccess && status.hostServe.phase === "failed" ? <PrimaryButton disabled={busy || !editable}
          onClick={() => { void act({ action: "retry" }); }}>Reconnect</PrimaryButton> : null}
        {!snapshot.capabilities ? <p role="status" className="m-0 text-sm text-fg/muted">Networking controls are waiting for the updated app runtime. Reload client:database, then refresh this page.</p> : null}
        <WorkbenchNetworkConnectionForm />
        <WorkbenchDaemonDiscovery />
        <div className="flex flex-wrap items-center gap-2 text-sm"><span>App URL</span>
          {appUrl ? <>
            <a className="min-w-0 break-all font-mono text-accent" href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
            <WorkbenchCopyButton label="Copy app address" text={appUrl} />
            <WorkbenchIconButton as="a" label="Open app" size="small" display="hover-border" href={appUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon className="size-4" /></WorkbenchIconButton>
          </> : <span className="text-fg/muted">not yet available</span>}
        </div>
        {service && tailnetUrl ? <ThreadDisclosure summary="Access this app from another device" contentClassName="flex flex-col gap-2 pt-3">
          {network.client.canAccessFromAnotherDevice() ? <>
            <p className="m-0 text-fg/muted">Open this address on the other device, then download and trust the certificate in Networking.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg/muted">Tailnet IP access</span>
              <code className="min-w-0 break-all text-text">{tailnetUrl}</code>
              <WorkbenchCopyButton label="Copy tailnet IP address" text={tailnetUrl} />
              <WorkbenchIconButton as="a" label="Open tailnet IP address" size="small" display="hover-border" href={tailnetUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon className="size-4" /></WorkbenchIconButton>
            </div>
            <WorkbenchQrCode text={tailnetUrl} />
          </> : <p className="m-0 text-fg/muted">Enable another device for this app under Shared network → App access.</p>}
        </ThreadDisclosure> : null}
        {snapshot.configuration.group ? <ThreadDisclosure summary="Shared network" contentClassName="pt-3">
          <WorkbenchNetworkAccessSettings />
        </ThreadDisclosure> : null}
        {busy && editable ? <PrimaryButton
          onClick={() => { void network.client.action({ action: "cancel" }).catch(() => setError("Cancellation could not be sent.")); }}>
          Cancel pending action
        </PrimaryButton> : null}
      </div>
    </section>
  );
}

export default function WorkbenchNetworkSettings () {
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

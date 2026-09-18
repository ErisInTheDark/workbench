/*
 * Default export:
 * - WorkbenchNetworkSettings: render one connection mode, its address controls and contextual setup.
 */
"use client";
import { useEffect, useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkClient, { WorkbenchNetworkClientContext, useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import WorkbenchPrivateAccessWizard from "./WorkbenchPrivateAccessWizard";
import WorkbenchNetworkConnectionForm from "./WorkbenchNetworkConnectionForm";
import WorkbenchQrCode from "./WorkbenchQrCode";
import PrimaryButton from "./PrimaryButton";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchNetworkAccessSettings from "./WorkbenchNetworkAccessSettings";
import ThreadDisclosure from "./thread-view/ThreadDisclosure";
import { CheckIcon, ExternalLinkIcon, SettingsIcon } from "./workbench-icons";

function NetworkSettingsContent() {
  const network = useWorkbenchNetwork();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [view, setView] = useState<"summary" | "access">("summary");
  const snapshot = network.snapshot;
  if (!snapshot) return <p className="text-sm text-fg/muted" role="status">{network.error ?? "Loading networking..."}</p>;
  const mode = workbenchNetworkMode(snapshot.configuration);
  const privateAccess = snapshot.configuration.privateAccess;
  const status = snapshot.runtime;
  const busy = snapshot.busy || working;
  const editable = snapshot.capabilities?.manageApp ?? false;
  const service = mode === "tailnet-service";
  const rawUrl = mode === "localhost" ? snapshot.localUrl : service ? status.privateAccess.url : status.hostServe.url;
  const appUrl = rawUrl ? new URL("/launch", rawUrl).href : null;
  const tailnetUrl = status.hostServe.url ? new URL("/launch", status.hostServe.url).href : null;
  const discoverable = mode !== "localhost" && status.daemonServe?.phase === "ready";

  async function act(action: WorkbenchNetworkAction, applied?: () => void | Promise<void>) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); await applied?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Networking could not be updated."); }
    finally { setWorking(false); }
  }

  return (
    <section className="max-w-3xl space-y-5 py-1">
      <h3 className="m-0 text-base font-semibold text-text">Networking</h3>
      {!snapshot.capabilities ? <p role="status" className="m-0 text-sm text-fg/muted">Networking controls are waiting for the updated app runtime. Reload client:database, then refresh this page.</p> : null}
      <WorkbenchNetworkConnectionForm />
      <div className="space-y-2 rounded-2xl bg-accent-soft/20 p-4 text-sm">
        <p className="m-0 flex flex-wrap items-center gap-2 text-text"><CheckIcon className={`size-4 ${discoverable ? "text-success" : "text-fg/muted"}`} />Daemon availability on tailnet{" "}
          <span className={discoverable ? "text-success" : "text-fg/muted"}>
            {discoverable ? "discoverable" : mode === "localhost" ? "local only" : "not discoverable"}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2 text-text"><span>App URL</span>
          {appUrl ? <>
            <a className="min-w-0 break-all font-mono text-accent" href={appUrl} target="_blank" rel="noreferrer">{appUrl}</a>
            <WorkbenchCopyButton label="Copy app address" text={appUrl} />
            <WorkbenchIconButton as="a" label="Open app" size="small" display="hover-border" href={appUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon className="size-4" /></WorkbenchIconButton>
          </> : <span className="text-fg/muted">not yet available</span>}
        </div>
        {service && tailnetUrl ? <ThreadDisclosure summary="Access this app from another device" className="pt-2" contentClassName="flex flex-col gap-2 pt-3">
          {network.client.canAccessFromAnotherDevice() ? <>
            <p className="m-0 text-fg/muted">Open this address on the other device, then download and trust the certificate in Networking.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg/muted">Tailnet IP access</span>
              <code className="min-w-0 break-all text-text">{tailnetUrl}</code>
              <WorkbenchCopyButton label="Copy tailnet IP address" text={tailnetUrl} />
              <WorkbenchIconButton as="a" label="Open tailnet IP address" size="small" display="hover-border" href={tailnetUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon className="size-4" /></WorkbenchIconButton>
            </div>
            <WorkbenchQrCode text={tailnetUrl} />
          </> : <p className="m-0 text-fg/muted">Enable another device for this app in Network access.</p>}
        </ThreadDisclosure> : null}
        {mode !== "localhost" && status.daemonServe?.message ? <p className="m-0 text-fg/muted">{status.daemonServe.message}</p> : null}
        {mode !== "localhost" && status.hostServe.message ? <p className="m-0 text-fg/muted">{status.hostServe.message}</p> : null}
        {snapshot.configuration.rename ? <p className="m-0 text-fg/muted">Changing address to {snapshot.configuration.rename.to}.wb.inthedark.boo...</p> : null}
      </div>
      {[network.error, snapshot.failure, error].filter((message, index, all) => message && all.indexOf(message) === index)
        .map(message => <p key={message} role="alert" className="m-0 text-sm text-danger">{message}</p>)}
      {mode !== "localhost" && snapshot.executable.message ? <p role="alert" className="text-sm text-danger">{snapshot.executable.message}</p> : null}
      {service && privateAccess ? <WorkbenchPrivateAccessWizard /> : null}
      {privateAccess ? <div className="flex flex-wrap gap-2">
        {snapshot.configuration.group ? <PrimaryButton aria-expanded={view === "access"} onClick={() => setView(view === "access" ? "summary" : "access")}><SettingsIcon className="mr-2 size-4" />Network access</PrimaryButton> : null}
      </div> : null}
      {view === "access" ? <WorkbenchNetworkAccessSettings /> : null}
      {busy && editable ? <PrimaryButton
        onClick={() => { void network.client.action({ action: "cancel" }).catch(() => setError("Cancellation could not be sent.")); }}>
        Cancel pending action
      </PrimaryButton> : null}
      {!privateAccess && service ? <p className="text-sm text-fg/muted">Apply a machine name to begin private HTTPS setup.</p> : null}
      {mode !== "localhost" && !privateAccess && status.hostServe.phase === "failed" ? <PrimaryButton disabled={busy || !editable}
        onClick={() => { void act({ action: "retry" }); }}>Reconnect</PrimaryButton> : null}
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

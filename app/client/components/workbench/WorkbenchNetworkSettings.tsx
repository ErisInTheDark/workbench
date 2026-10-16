/*
 * Default export:
 * - WorkbenchNetworkSettings: "This app" (status, setup, connection) and "Other devices" (address, shared access) sections.
 */
"use client";
import { useContext, useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import { WorkbenchNetworkClientContext, useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import Disclosure from "../ui/Disclosure";
import FormSection from "../ui/FormSection";
import PrimaryButton from "../ui/PrimaryButton";
import SettingsCard, { SettingsCardRow } from "../ui/SettingsCard";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import IconButton from "../ui/IconButton";
import LoaderIcon from "./LoaderIcon";
import WorkbenchNetworkAccessSettings from "./WorkbenchNetworkAccessSettings";
import WorkbenchNetworkConnectionForm from "./WorkbenchNetworkConnectionForm";
import WorkbenchPrivateAccessWizard from "./WorkbenchPrivateAccessWizard";
import WorkbenchQrCode from "./WorkbenchQrCode";
import { CheckIcon, ExternalLinkIcon, TriangleAlertIcon } from "./workbench-icons";

function Address({ label, url }: { label: string; url: string }) {
  return <span className="flex min-w-0 items-center gap-1">
    <a className="min-w-0 break-all font-mono text-[0.8rem] text-accent" href={url} target="_blank" rel="noreferrer">{url}</a>
    <WorkbenchCopyButton label={`Copy ${label}`} text={url} />
    <IconButton as="a" label={`Open ${label}`} size="small" display="hover-border" href={url} target="_blank" rel="noreferrer">
      <ExternalLinkIcon className="size-4" />
    </IconButton>
  </span>;
}

function NetworkSettingsContent () {
  const network = useWorkbenchNetwork();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const snapshot = network.snapshot;
  if (!snapshot) {
    return <FormSection id="settings-connection" title="Connection">
      <p className="m-0 text-sm text-fg/muted" role="status">{network.error ?? "Loading networking..."}</p>
    </FormSection>;
  }
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
  const attention = service
    ? !httpsReady && (network.verification.phase === "failed" || status.privateAccess.phase === "failed" || !snapshot.executable.available)
    : mode !== "localhost" && status.hostServe.phase !== "ready";
  const connectionStatus = mode === "localhost" ? "Only this computer"
    : service ? httpsReady ? "HTTPS ready"
      : network.verification.phase === "checking" ? "Checking HTTPS..."
        : attention ? "HTTPS needs attention" : "Setting up HTTPS..."
      : status.hostServe.phase === "ready" ? "Tailnet ready" : "Tailnet connection needs attention";
  const messages = [
    mode !== "localhost" ? status.daemonServe?.message : null,
    mode !== "localhost" ? status.hostServe.message : null,
    snapshot.configuration.rename ? `Changing address to ${snapshot.configuration.rename.to}.wb.inthedark.boo...` : null,
  ].filter((message): message is string => Boolean(message));
  const failures = [network.error, snapshot.failure, error, mode !== "localhost" ? snapshot.executable.message : null]
    .filter((message, index, all): message is string => Boolean(message) && all.indexOf(message) === index);
  const otherDevices = mode !== "localhost" && tailnetUrl && network.client.canAccessFromAnotherDevice();

  async function act (action: WorkbenchNetworkAction) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Networking could not be updated."); }
    finally { setWorking(false); }
  }

  return <>
    <FormSection id="settings-connection" title="This app">
      <div className="space-y-3 py-1">
        {service && privateAccess ? <WorkbenchPrivateAccessWizard /> : null}
        {!snapshot.capabilities ? <p role="status" className="m-0 text-sm text-fg/muted">Networking controls are waiting for the updated app runtime. Reload client:database, then refresh this page.</p> : null}
        <WorkbenchNetworkConnectionForm>
          <SettingsCardRow label="Status">
            <span role="status" className="flex items-center gap-2 text-text">
              {attention ? <TriangleAlertIcon className="size-4 text-[color:var(--attention)]" />
                : service && !httpsReady ? <LoaderIcon size={14} />
                  : <CheckIcon className="size-4 text-success" />}
              {connectionStatus}
            </span>
            {busy && editable ? <PrimaryButton shape="compact" className="ml-auto"
              onClick={() => { void network.client.action({ action: "cancel" }).catch(() => setError("Cancellation could not be sent.")); }}>
              Cancel
            </PrimaryButton> : null}
          </SettingsCardRow>
          {appUrl ? <SettingsCardRow label="App address"><Address label="app address" url={appUrl} /></SettingsCardRow> : null}
          {messages.length || failures.length ? <SettingsCardRow>
            <div className="space-y-1">
              {messages.map(message => <p key={message} className="m-0 text-fg/muted">{message}</p>)}
              {failures.map(message => <p key={message} role="alert" className="m-0 text-danger">{message}</p>)}
            </div>
          </SettingsCardRow> : null}
          {mode !== "localhost" && !privateAccess && status.hostServe.phase === "failed" ? <SettingsCardRow>
            <PrimaryButton shape="compact" disabled={busy || !editable} onClick={() => { void act({ action: "retry" }); }}>Reconnect</PrimaryButton>
          </SettingsCardRow> : null}
        </WorkbenchNetworkConnectionForm>
      </div>
    </FormSection>
    <FormSection id="settings-app-access" title="Other devices">
      <div className="py-1">
        {mode === "localhost"
          ? <p className="m-0 text-sm text-fg/muted">Only this computer can open the app. Use a tailnet connection to reach it from other devices.</p>
          : <SettingsCard label="Other devices">
            {tailnetUrl ? <SettingsCardRow label="Open at">
              {otherDevices ? <div className="min-w-0 space-y-1">
                <Address label="tailnet address" url={tailnetUrl} />
                <Disclosure summary="QR code" className="text-fg/muted" contentClassName="pt-2"><WorkbenchQrCode text={tailnetUrl} /></Disclosure>
              </div> : <span className="text-fg/muted">Allow other devices below to open this app.</span>}
            </SettingsCardRow> : null}
            {snapshot.configuration.group ? <WorkbenchNetworkAccessSettings /> : null}
          </SettingsCard>}
      </div>
    </FormSection>
  </>;
}

export default function WorkbenchNetworkSettings () {
  const client = useContext(WorkbenchNetworkClientContext);
  if (!client) return null;
  return <NetworkSettingsContent />;
}

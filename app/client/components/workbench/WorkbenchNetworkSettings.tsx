/*
 * Default export:
 * - WorkbenchNetworkSettings: app reachability status, any needed setup, Connection, Other devices with certificate download,
 *   and Network rules (sync with the owner, private DNS and device grants, marked in its summary when they need attention).
 */
"use client";
import { useContext, useState } from "react";
import { workbenchNetworkMode, type WorkbenchNetworkAction, type WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import { WorkbenchNetworkClientContext, useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import { networkDnsCoverage } from "../../workbench/app/network-dns-coverage";
import WorkbenchNetworkPrivateDns from "./WorkbenchNetworkPrivateDns";
import WorkbenchNetworkSync, { type WorkbenchNetworkSyncState } from "./WorkbenchNetworkSync";
import Disclosure from "../ui/Disclosure";
import FormSection from "../ui/FormSection";
import PrimaryButton from "../ui/PrimaryButton";
import SettingsCard, { SettingsCardRow } from "../ui/SettingsCard";
import WorkbenchCertificateInstall from "./WorkbenchCertificateInstall";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import IconButton from "../ui/IconButton";
import LoaderIcon from "./LoaderIcon";
import WorkbenchNetworkAccessSettings from "./WorkbenchNetworkAccessSettings";
import WorkbenchNetworkConnectionForm from "./WorkbenchNetworkConnectionForm";
import WorkbenchPrivateAccessWizard from "./WorkbenchPrivateAccessWizard";
import WorkbenchQrCode from "./WorkbenchQrCode";
import { CheckIcon, ExternalLinkIcon, TriangleAlertIcon, XIcon } from "./workbench-icons";

function networkSyncState(snapshot: WorkbenchNetworkSnapshot): WorkbenchNetworkSyncState {
  const status = snapshot.runtime.privateAccess;
  const group = snapshot.configuration.group;
  const owner = group ? snapshot.configuration.members.find(member => member.nodeId === group.ownerNodeId) ?? null : null;
  if (group && owner && owner.nodeId === status.nodeId) return { kind: "owner" };
  if (status.discovery === "failed") {
    const ownerOnline = owner ? status.tailnetDns?.members?.find(entry => owner.addresses.includes(entry.address))?.online ?? null : null;
    return { kind: "failed", owner: owner?.label ?? null, ownerOnline, detail: status.message };
  }
  return { kind: "synced", owner: owner?.label ?? "this network's owner", revision: group?.revision ?? 0 };
}

function RulesChip({ label, state }: { label: string; state: "ok" | "attention" | "danger" }) {
  const Icon = state === "ok" ? CheckIcon : state === "danger" ? XIcon : TriangleAlertIcon;
  return <span className={`flex items-center gap-1 ${state === "ok" ? "text-fg/muted" : state === "danger" ? "text-danger" : "text-[color:var(--attention)]"}`}>
    <Icon size={14} className="size-3.5" />{label}
  </span>;
}

/** Shows `url` itself, or `text` in its place when the address is too long to be worth reading. */
function Address({ label, url, text }: { label: string; url: string; text?: string }) {
  return <span className="flex min-w-0 items-center gap-1">
    {text ? <span className="text-text">{text}</span>
      : <a className="min-w-0 break-all font-mono text-[0.8rem] text-accent" href={url} target="_blank" rel="noreferrer">{url}</a>}
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
  // Another device lands on this page, where it can trust the certificate before HTTPS works there.
  const tailnetUrl = status.hostServe.url ? new URL("/@/settings#settings-connection", status.hostServe.url).href : null;
  const dns = service ? networkDnsCoverage(snapshot) : null;
  const sync = networkSyncState(snapshot);
  const attention = service
    ? dns?.verdict === "broken" || !httpsReady && (network.verification.phase === "failed" || status.privateAccess.phase === "failed" || !snapshot.executable.available)
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

  const group = snapshot.configuration.group;
  const tone = attention ? "attention" : service && !httpsReady ? "pending" : "ready";
  return <section id="settings-connection" className="scroll-mt-24 space-y-4 pt-6">
    <div className="flex min-w-0 items-center gap-4">
      <span aria-hidden="true" className={`
        flex size-10 shrink-0 items-center justify-center rounded-full
        ${tone === "ready" ? "bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success"
          : tone === "attention" ? "bg-[color-mix(in_srgb,var(--attention)_16%,transparent)] text-[color:var(--attention)]"
            : "bg-fg/5 text-fg/muted"}
      `}>
        {tone === "attention" ? <TriangleAlertIcon className="size-5" /> : tone === "pending" ? <LoaderIcon size={18} /> : <CheckIcon className="size-5" />}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p role="status" className="m-0 text-base font-semibold text-text">{connectionStatus}</p>
        {appUrl ? <Address label="app address" url={appUrl} /> : null}
      </div>
      {busy && editable ? <PrimaryButton shape="compact"
        onClick={() => { void network.client.action({ action: "cancel" }).catch(() => setError("Cancellation could not be sent.")); }}>
        Cancel
      </PrimaryButton> : null}
    </div>
    {messages.length || failures.length ? <div className="space-y-1 px-1 text-sm">
      {messages.map(message => <p key={message} className="m-0 text-fg/muted">{message}</p>)}
      {failures.map(message => <p key={message} role="alert" className="m-0 text-danger">{message}</p>)}
    </div> : null}
    {mode !== "localhost" && !privateAccess && status.hostServe.phase === "failed"
      ? <PrimaryButton shape="compact" disabled={busy || !editable} onClick={() => { void act({ action: "retry" }); }}>Reconnect</PrimaryButton> : null}
    {service && privateAccess ? <WorkbenchPrivateAccessWizard /> : null}
    {!snapshot.capabilities ? <p role="status" className="m-0 text-sm text-fg/muted">Networking controls are waiting for the updated app runtime. Reload client:database, then refresh this page.</p> : null}
    <div className="@container pt-2"><div className="flex flex-col gap-6 @4xl:flex-row @4xl:gap-0">
      <div className="min-w-0 flex-1 @4xl:pr-6"><WorkbenchNetworkConnectionForm /></div>
      <div className="flex min-w-0 items-start gap-4 text-sm @4xl:w-[22rem] @4xl:shrink-0 @4xl:border-l @4xl:border-fg/10 @4xl:pl-6">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="m-0 text-sm font-semibold text-text">Set up another device</h3>
          <p className="m-0 text-detail text-fg/muted">{mode === "localhost"
            ? "Only this computer can open the app. Choose a tailnet connection to reach it from other devices."
            : !tailnetUrl || !otherDevices ? "Allow the device under Network rules first."
              : service ? "Before Tailnet service works on another device, you must open this page via the tailnet IP and trust the certificate."
                : "Open this page via the tailnet IP on the other device."}</p>
          {mode !== "localhost" && tailnetUrl && otherDevices ? <Address label="tailnet IP URL" url={tailnetUrl} text="Tailnet IP URL" /> : null}
          {service && otherDevices && status.privateAccess.rootCertificate
            ? <div className="flex flex-col items-start gap-2 pt-1"><WorkbenchCertificateInstall certificate={status.privateAccess.rootCertificate} /></div> : null}
        </div>
        {mode !== "localhost" && tailnetUrl && otherDevices ? <WorkbenchQrCode text={tailnetUrl} className="size-28" /> : null}
      </div>
    </div></div>
    {group ? <Disclosure id="settings-app-access" className="scroll-mt-24 border-t border-fg/8" summaryClassName="py-2.5 text-base" contentClassName="pb-3 pl-7"
      summary={<span className="flex min-w-0 items-center justify-between gap-3">
        <span className="font-medium text-text">Network rules</span>
        {service ? <span className="flex shrink-0 items-center gap-3 text-sm">
          <RulesChip label="Sync" state={sync.kind === "failed" ? "attention" : "ok"} />
          <RulesChip label="DNS" state={!dns ? "ok" : dns.verdict === "broken" ? "danger" : dns.verdict === "fragile" ? "attention" : "ok"} />
        </span> : null}
      </span>}>
      <div className="space-y-4">
        {service ? <>
          <WorkbenchNetworkSync state={sync} busy={busy || !editable} onRetry={() => { void act({ action: "retry" }); }} />
          <WorkbenchNetworkPrivateDns coverage={dns} />
        </> : null}
        <SettingsCard label="Network rules" flush><WorkbenchNetworkAccessSettings /></SettingsCard>
      </div>
    </Disclosure> : null}
  </section>;
}

export default function WorkbenchNetworkSettings () {
  const client = useContext(WorkbenchNetworkClientContext);
  if (!client) return null;
  return <NetworkSettingsContent />;
}

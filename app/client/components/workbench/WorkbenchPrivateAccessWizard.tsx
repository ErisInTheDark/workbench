/*
 * Default export:
 * - WorkbenchPrivateAccessWizard: show one actionable connection, DNS or device-trust step.
 */
"use client";
import { useState } from "react";
import type { WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import privateAccessStep from "../../workbench/app/private-access-step";
import PrimaryButton from "./PrimaryButton";
import LoaderIcon from "./LoaderIcon";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import { CheckIcon, ExternalLinkIcon, LockIcon, RefreshCwIcon, WarningIcon } from "./workbench-icons";

export default function WorkbenchPrivateAccessWizard() {
  const network = useWorkbenchNetwork();
  const [dnsConfirmed, setDnsConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ step: string; message: string } | null>(null);
  const snapshot = network.snapshot;
  if (!snapshot) return null;
  const status = snapshot.runtime.privateAccess;
  const configuration = snapshot.configuration.privateAccess;
  const dnsApp = snapshot.configuration.members.find(member => member.nodeId === snapshot.configuration.group?.dnsNodeId);
  const step = privateAccessStep(snapshot, Boolean(network.verified), dnsConfirmed);
  const busy = working || snapshot.busy;
  const editable = snapshot.capabilities?.manageApp ?? false;
  async function run(operation: () => Promise<object>) {
    setWorking(true);
    setError(null);
    try { await operation(); }
    catch (failure) { setError({ step, message: failure instanceof Error ? failure.message : "Private access could not be updated." }); }
    finally { setWorking(false); }
  }
  const act = (action: WorkbenchNetworkAction) => { void run(() => network.client.action(action)); };
  const waiting = step === "connecting" || step === "discovering";
  const title = {
    prepare: "Connect this app", connecting: "Connecting to your tailnet", discovering: "Finding your Workbench network",
    signin: "Sign in to Tailscale", create: "Set up your Workbench network", choose: "Choose your Workbench network",
    dns: "Add your Workbench nameserver", trust: "Trust HTTPS on this device", ready: "Private HTTPS is ready", failed: "Private access needs attention",
  }[step];
  return <section className="flex flex-col items-start gap-4 rounded-2xl bg-accent-soft/20 p-4 sm:p-5">
    <div className="flex items-center gap-2 text-sm font-medium text-text" role="status">
      {waiting ? <LoaderIcon className="size-4" /> : step === "ready" ? <CheckIcon className="size-4 text-success" />
        : step === "failed" ? <WarningIcon className="size-4 text-danger" /> : <LockIcon className="size-4" />}
      <h4 className="m-0 text-sm font-medium">{title}</h4>
    </div>
    {waiting ? <p className="m-0 text-sm text-fg/muted">{step === "discovering" ? "Existing apps are found automatically. There is no pairing code to copy." : "Workbench is opening its own private connection. Your computer's normal ports stay untouched."}</p> : null}
    {step === "prepare" && configuration ? <PrimaryButton disabled={busy || !editable} onClick={() => act({ action: "prepare", label: configuration.label })}>Connect app</PrimaryButton> : null}
    {step === "signin" && status.loginUrl ? <WorkbenchLinkButton href={status.loginUrl} target="_blank" rel="noreferrer">
      Sign in to connect this app<ExternalLinkIcon className="size-4" />
    </WorkbenchLinkButton> : null}
    {step === "create" ? <>
      <p className="m-0 text-sm text-fg/muted">{status.message ?? "No existing network was found. Set it up here once. Later apps can join automatically."}</p>
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton disabled={busy || !editable} pendingHalo={busy} onClick={() => act({ action: "create-setup" })}>Create network</PrimaryButton>
        <PrimaryButton disabled={busy || !editable} onClick={() => act({ action: "discover" })}>Look again</PrimaryButton>
      </div>
    </> : null}
    {step === "choose" ? <div className="flex flex-wrap gap-2">{status.networks?.map(candidate => <PrimaryButton key={candidate.id} disabled={busy || !editable}
      onClick={() => act({ action: "select-network", id: candidate.id })}>{candidate.label}'s network</PrimaryButton>)}</div> : null}
    {step === "dns" ? <>
      <p className="m-0 text-sm text-fg/muted">In Tailscale DNS settings, add this nameserver and restrict it to <strong className="font-medium text-text">wb.inthedark.boo</strong>. This is one entry for every app, not one per computer.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="select-all text-sm text-text">{dnsApp?.addresses[0] ?? "Waiting for the DNS app address"}</code>
        {dnsApp?.addresses[0] ? <WorkbenchCopyButton label="Copy nameserver address" text={dnsApp.addresses[0]} /> : null}
        <WorkbenchLinkButton href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">Open Tailscale DNS<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
      </div>
      <PrimaryButton onClick={() => setDnsConfirmed(true)}>I've added the entry</PrimaryButton>
    </> : null}
    {step === "trust" && status.rootCertificate ? <>
      <p className="m-0 text-sm text-fg/muted">Install and trust this certificate on the device you're using now. You only need to do this once per device, not for every Workbench app.</p>
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.hostPlatform === "win32" && editable && snapshot.capabilities?.trustHost
          ? <PrimaryButton disabled={busy} onClick={() => act({ action: "trust-host" })}><LockIcon className="mr-2 size-4" />Trust certificate on this PC</PrimaryButton>
          : null}
        <WorkbenchLinkButton download="workbench-private-root.crt" href={`data:application/x-x509-ca-cert,${encodeURIComponent(status.rootCertificate)}`}>Download certificate</WorkbenchLinkButton>
      </div>
      <details className="text-sm text-fg/muted">
        <summary className="cursor-pointer text-text">How do I install it?</summary>
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="m-0">Open the downloaded certificate in your device's certificate settings and enable trust for websites. Only trust it if you recognise this Workbench network.</p>
          <p className="m-0">On another Windows PC, import it into your Current User &gt; Trusted Root Certification Authorities store.</p>
          <WorkbenchLinkButton href="https://learn.microsoft.com/en-us/windows-hardware/drivers/install/trusted-root-certification-authorities-certificate-store" target="_blank" rel="noreferrer">Windows certificate help<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
          <WorkbenchLinkButton href="https://support.apple.com/en-ie/102390" target="_blank" rel="noreferrer">iPhone and iPad instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
          <WorkbenchLinkButton href="https://support.apple.com/en-ie/guide/keychain-access/kyca11871/mac" target="_blank" rel="noreferrer">Mac instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
          <WorkbenchLinkButton href="https://support.google.com/pixelphone/answer/2844832?hl=en" target="_blank" rel="noreferrer">Android instructions<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
        </div>
      </details>
      <div className="flex flex-col items-start gap-2">
        <p className="m-0 text-sm text-fg/muted">Once the certificate is trusted, check that this browser can open the HTTPS address.</p>
        <PrimaryButton disabled={busy} pendingHalo={busy} onClick={() => { void run(() => network.client.verify()); }}>Check HTTPS connection</PrimaryButton>
      </div>
    </> : null}
    {step === "ready" ? <p className="m-0 text-sm text-fg/muted">This browser verified the private address and the expected app.</p> : null}
    {configuration?.role !== "unconfigured" && step !== "failed" && status.discovery === "failed" ? <div className="space-y-2">
      <p className="m-0 text-sm text-fg/muted">{status.message ?? "Network updates could not be checked. Previously saved access settings remain in use."}</p>
      <PrimaryButton disabled={busy || !editable} onClick={() => act({ action: "retry" })}><RefreshCwIcon className="mr-2 size-4" />Check network updates</PrimaryButton>
    </div> : null}
    {step === "failed" ? <>
      <p className="m-0 text-sm text-fg/muted">{snapshot.executable.message ?? status.message ?? snapshot.failure ?? "The connection could not complete."}</p>
      <PrimaryButton disabled={busy || !editable} onClick={() => act({ action: "retry" })}><RefreshCwIcon className="mr-2 size-4" />Reconnect</PrimaryButton>
    </> : null}
    {error?.step === step ? <p className="m-0 text-sm text-danger" role="alert">{error.message}</p> : null}
  </section>;
}

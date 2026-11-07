/*
 * Default export:
 * - WorkbenchPrivateAccessWizard: show one actionable connection, DNS or device-trust step.
 */
"use client";
import { useState } from "react";
import type { WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import privateAccessStep from "../../workbench/app/private-access-step";
import PrimaryButton from "../ui/PrimaryButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import WorkbenchCertificateInstall from "./WorkbenchCertificateInstall";
import WorkbenchCertificateTrust from "./WorkbenchCertificateTrust";
import WorkbenchNetworkNameservers from "./WorkbenchNetworkNameservers";
import { ExternalLinkIcon, RefreshCwIcon } from "./workbench-icons";

export default function WorkbenchPrivateAccessWizard() {
  const network = useWorkbenchNetwork();
  const [dnsConfirmed, setDnsConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ step: string; message: string } | null>(null);
  const snapshot = network.snapshot;
  if (!snapshot) return null;
  const status = snapshot.runtime.privateAccess;
  const configuration = snapshot.configuration.privateAccess;
  const step = privateAccessStep(snapshot, network.verification.phase, dnsConfirmed);
  const busy = working || snapshot.busy || network.verification.phase === "checking";
  const editable = snapshot.capabilities?.manageApp ?? false;
  async function run(operation: () => Promise<object | void>) {
    setWorking(true);
    setError(null);
    try { await operation(); }
    catch (failure) { setError({ step, message: failure instanceof Error ? failure.message : "Private access could not be updated." }); }
    finally { setWorking(false); }
  }
  const act = (action: WorkbenchNetworkAction) => { void run(() => network.client.action(action)); };
  const waiting = step === "connecting" || step === "discovering";
  if ((step === "ready" || step === "checking") && status.discovery !== "failed" && !error) return null;
  return <section aria-label="Private HTTPS setup" className="
    flex flex-col items-start gap-3 rounded-[0.95rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-3 text-sm
  ">
    {network.verification.phase === "failed" && (step === "dns" || step === "trust")
      ? <p role="alert" className="m-0 text-danger">{network.verification.message}</p> : null}
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
      <WorkbenchNetworkNameservers />
      <PrimaryButton disabled={busy} onClick={() => { setDnsConfirmed(true); void run(() => network.client.verify()); }}>I've added the nameservers</PrimaryButton>
    </> : null}
    {step === "trust" && status.rootCertificate ? <>
      <div className="flex flex-wrap items-center gap-2">
        <WorkbenchCertificateTrust
          busy={busy}
          certificate={status.rootCertificate}
          enabled={editable && snapshot.capabilities?.trustHost === true}
          hostPlatform={snapshot.hostPlatform}
          onCopyFailure={() => setError({ step, message: "Certificate install command could not be copied." })}
          onTrust={() => act({ action: "trust-host" })}
        />
        <PrimaryButton disabled={busy} pendingHalo={busy} onClick={() => { void run(() => network.client.verify()); }}><RefreshCwIcon className="mr-2 size-4" />Retry HTTPS check</PrimaryButton>
      </div>
      <WorkbenchCertificateInstall certificate={status.rootCertificate} />
    </> : null}
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

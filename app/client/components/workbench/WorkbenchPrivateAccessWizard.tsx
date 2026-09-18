/*
 * Default export:
 * - WorkbenchPrivateAccessWizard: render enrolment, pairing, device trust, verification and authority recovery intents.
 */
"use client";
import { useState } from "react";
import type { WorkbenchNetworkAction } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";

const buttonStyle = "rounded-lg px-3 py-2 text-sm text-text hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40";
const inputStyle = "w-full min-w-0 rounded-lg bg-transparent px-2 py-2 text-sm text-text outline-none focus:ring-2 focus:ring-accent-soft";

export default function WorkbenchPrivateAccessWizard() {
  const network = useWorkbenchNetwork();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [code, setCode] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [password, setPassword] = useState("");
  const [backup, setBackup] = useState("");
  const [download, setDownload] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [verified, setVerified] = useState<{ hostname: string; nodeId: string; rootFingerprint: string | null } | null>(null);
  const snapshot = network.snapshot;
  if (!snapshot) return null;
  const configuration = snapshot.configuration.privateAccess;
  const status = snapshot.runtime.privateAccess;
  const busy = snapshot.busy || working;
  const prepared = Boolean(status.nodeId);

  async function act(action: WorkbenchNetworkAction) {
    setWorking(true);
    setError("");
    try {
      const result = await network.client.action(action);
      if (result.kind === "pairing-code") setPairingCode(result.code);
      if (result.kind === "backup") setDownload(result.data);
      if (result.kind === "setup") { setClientSecret(""); setCode(""); setBackup(""); setPassword(""); }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Private setup could not complete.");
    } finally { setWorking(false); }
  }

  async function verify() {
    setWorking(true);
    setError("");
    try {
      setVerified(await network.client.verify());
    } catch {
      setError("This device could not verify private HTTPS. Check Tailscale DNS and install the setup certificate as a trusted root on this device, then retry.");
    } finally { setWorking(false); }
  }

  return (
    <div className="space-y-4">
      <h4 className="m-0 font-medium text-text">Private HTTPS setup</h4>
      <p role="status" className="m-0 text-sm text-fg/muted">{status.phase}{status.message ? ` · ${status.message}` : ""}</p>
      {status.loginUrl ? <a className="text-accent underline" href={status.loginUrl} target="_blank" rel="noreferrer">Authorise this Workbench node in Tailscale</a> : null}
      {configuration && !prepared ? <button className={buttonStyle} disabled={busy || !snapshot.executable.available}
        onClick={() => { void act({ action: "prepare", label: configuration.label }); }}>Prepare / reconnect node</button> : null}
      {prepared && configuration?.role === "unconfigured" ? (
        <div className="space-y-4">
          <details>
            <summary className="cursor-pointer text-sm text-text">Create the first private setup</summary>
            <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void act({ action: "create-setup", clientId, clientSecret }); }}>
              <p className="text-sm text-fg/muted">Once per setup, create a Tailscale OAuth client with DNS write permission. Only this installation keeps the credential and certificate authority key. Other machines join below.</p>
              <label className="block text-sm text-text">Client ID<input value={clientId} onChange={event => setClientId(event.currentTarget.value)} required autoComplete="off" className={inputStyle} /></label>
              <label className="block text-sm text-text">Client secret<input type="password" value={clientSecret} onChange={event => setClientSecret(event.currentTarget.value)} required autoComplete="off" className={inputStyle} /></label>
              <button disabled={busy} className={buttonStyle}>Create setup and register DNS</button>
            </form>
          </details>
          <p className="text-sm text-fg/muted">Already have a setup? Generate a pairing code on its setup installation, paste it below, then approve this machine there.</p>
        </div>
      ) : null}
      {prepared && configuration?.role !== "authority" ? (
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void act({ action: configuration?.role === "member" ? "reconnect" : "join", code }); }}>
          <label className="block text-sm text-text">Pairing / issuer reconnection code<textarea value={code} onChange={event => setCode(event.currentTarget.value)} required maxLength={32768} rows={3} autoComplete="off" className={inputStyle} /></label>
          <button className={buttonStyle} disabled={busy}>{configuration?.role === "member" ? "Reconnect to recovered issuer" : "Join existing setup"}</button>
        </form>
      ) : null}
      {prepared && configuration?.role === "authority" ? (
        <div className="space-y-2">
          <button className={buttonStyle} disabled={busy} onClick={() => { void act({ action: "pair-code" }); }}>Generate single-use pairing code</button>
          {pairingCode ? <label className="block text-sm text-text">Copy privately to the other installation<textarea readOnly value={pairingCode} rows={3} className={inputStyle} onFocus={event => event.currentTarget.select()} /></label> : null}
          {status.pending.map(pending => <div key={pending.id} className="space-y-2 py-2">
            <p className="break-all text-sm text-text">Approve {pending.member.label}?</p>
            <p className="break-all font-mono text-xs text-fg/muted">Node {pending.member.nodeId}<br />Key {pending.member.keyFingerprint}</p>
            <p className="text-sm text-fg/muted">Check this identity and key against the joining installation before approving.</p>
            <button disabled={busy} className={buttonStyle} onClick={() => { void act({ action: "approve", requestId: pending.id, approved: true }); }}>Approve machine</button>
            <button disabled={busy} className={buttonStyle} onClick={() => { void act({ action: "approve", requestId: pending.id, approved: false }); }}>Decline</button>
          </div>)}
        </div>
      ) : null}
      {status.nodeId ? <p className="break-all font-mono text-xs text-fg/muted">This node {status.nodeId}</p> : null}
      {status.keyFingerprint ? <p className="break-all font-mono text-xs text-fg/muted">This key {status.keyFingerprint}</p> : null}
      {status.rootCertificate ? (
        <div className="space-y-2">
          <h5 className="m-0 text-sm font-medium text-text">Trust once on each viewing device</h5>
          <p className="text-sm text-fg/muted">Install this setup's certificate as a trusted root in the device or browser you use for Workbench. Only trust a setup you control. Pairing another machine does not require trusting a new root.</p>
          <a className="text-sm text-accent underline" download="workbench-private-root.crt"
            href={`data:application/x-x509-ca-cert,${encodeURIComponent(status.rootCertificate)}`}>Download public root certificate</a>
          <p className="break-all font-mono text-xs text-fg/muted">SHA-256 {status.rootFingerprint}</p>
          {snapshot.hostPlatform === "win32" ? <button className={buttonStyle} disabled={busy} onClick={() => { void act({ action: "trust-host" }); }}>
            Trust root for current user on the Workbench Windows host
          </button> : null}
          <p className="text-sm text-fg/muted">The host button does not install trust on a remote phone or laptop.</p>
          <button className={buttonStyle} disabled={busy || !prepared} onClick={() => { void verify(); }}>Verify HTTPS from this device</button>
          {verified && verified.rootFingerprint === status.rootFingerprint && verified.hostname === status.hostname && verified.nodeId === status.nodeId
            ? <p className="text-sm text-text" role="status">Private DNS, HTTPS trust and machine identity verified from this browser.</p> : null}
          {status.certificateExpiresAt ? <p className="text-sm text-fg/muted">Leaf certificate expires {new Date(status.certificateExpiresAt).toLocaleDateString()}. Keep the setup installation available for renewal in its final 30 days.</p> : null}
        </div>
      ) : null}
      {configuration && configuration.role !== "unconfigured" ? (
        <div className="flex flex-wrap gap-2">
          {status.url ? <a className={buttonStyle} href={status.url} target="_blank" rel="noreferrer">Open private Workbench</a> : null}
          <button disabled={busy} className={buttonStyle} onClick={() => { void act({ action: "remove-registration" }); }}>Remove this machine's DNS registration and disable</button>
        </div>
      ) : null}
      {configuration ? (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm text-text">Encrypted backup and recovery</summary>
          <p className="text-sm text-fg/muted">A backup contains the setup's CA private key, DNS credential and approved members. Store it privately. Recovery retains the same root. If the issuer address changes, reconnect members using a new pairing code.</p>
          <label className="block text-sm text-text">Backup password<input type="password" autoComplete="new-password" value={password} minLength={12} maxLength={1024} onChange={event => setPassword(event.currentTarget.value)} className={inputStyle} /></label>
          {configuration.role === "authority" ? <button disabled={busy || password.length < 12} className={buttonStyle} onClick={() => { void act({ action: "backup", password }); }}>Create encrypted backup</button> : null}
          {download ? <a className="text-sm text-accent underline" download="workbench-private.wbbackup" href={`data:text/plain;charset=utf-8,${encodeURIComponent(download)}`}>Save encrypted backup</a> : null}
          <label className="block text-sm text-text">Recovery backup<input type="file" accept=".wbbackup,text/plain" className={inputStyle}
            onChange={event => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              if (file.size > 6000000) { setError("Backup is too large."); return; }
              void file.text().then(setBackup).catch(() => setError("Backup file could not be read."));
            }} /></label>
          <button disabled={busy || !prepared || !backup || password.length < 12} className={buttonStyle} onClick={() => { void act({ action: "restore", password, backup }); }}>Restore this setup authority</button>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button className={buttonStyle} disabled={busy} onClick={() => { void act({ action: "retry" }); }}>Retry networking / renew registration</button>
      </div>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

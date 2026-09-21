/*
 * Exports:
 * - default WorkbenchDaemonDiscovery: render granted daemon observations without selecting remote work.
 */
"use client";
import { useState } from "react";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";

export default function WorkbenchDaemonDiscovery() {
  const network = useWorkbenchNetwork();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const discovery = network.snapshot?.discovery;
  const daemon = network.snapshot?.daemon;
  if (!discovery && !daemon) return null;

  async function act(action: "daemon-discovery-refresh" | "daemon-wake-retry") {
    setWorking(true);
    setError(null);
    try { await network.client.action({ action }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Daemon request failed."); }
    finally { setWorking(false); }
  }

  return <section className="space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="m-0 font-medium text-text">Daemons</h4>
      <button type="button" className="rounded px-2 py-1 text-sm text-fg/muted hover:bg-fg/5 hover:text-text disabled:opacity-50"
        disabled={working || discovery?.refreshing} onClick={() => { void act("daemon-discovery-refresh"); }}>
        {discovery?.refreshing ? "Discovering..." : "Refresh"}
      </button>
    </header>
    {daemon ? <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{daemon.hostname}</span>
        <span className="text-fg/muted">this device · {daemon.state}</span>
        {daemon.state === "failed" && network.snapshot?.capabilities?.manageApp
          ? <button type="button" disabled={working} className="rounded px-2 py-1 text-accent hover:bg-fg/5 disabled:opacity-50"
            onClick={() => { void act("daemon-wake-retry"); }}>Retry startup</button> : null}
      </div>
      <p className="m-0 break-all font-mono text-xs text-fg/muted">{daemon.daemonId}</p>
    </div> : null}
    {discovery?.peers.map(peer => <div key={peer.peerId} className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{peer.hostname}</span>
        <span className="text-fg/muted">{peer.phase === "verified" ? peer.identity.state : peer.phase}</span>
      </div>
      {peer.phase === "verified" ? <>
        <p className="m-0 break-all font-mono text-xs text-fg/muted">{peer.identity.daemonId}</p>
        <p className="m-0 break-all text-fg/muted">{peer.origin}</p>
      </> : peer.phase === "failed" ? <p className="m-0 text-fg/muted">{peer.message}</p> : null}
    </div>)}
    {discovery && !discovery.refreshing && discovery.peers.length === 0
      ? <p className="m-0 text-sm text-fg/muted">No accessible daemons discovered on this tailnet.</p> : null}
    {error ? <p role="alert" className="m-0 text-sm text-danger">{error}</p> : null}
    {discovery?.error ? <p role="alert" className="m-0 text-sm text-danger">{discovery.error}</p> : null}
  </section>;
}

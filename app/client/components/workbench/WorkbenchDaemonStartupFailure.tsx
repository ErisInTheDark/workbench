/*
 * Exports:
 * - default WorkbenchDaemonStartupFailure: show why this device's daemon failed and offer an immediate retry.
 */
"use client";
import { useContext, useState } from "react";
import { useWorkbenchNetwork, WorkbenchNetworkClientContext } from "../../workbench/app/WorkbenchNetworkClient";

export default function WorkbenchDaemonStartupFailure({ className = "" }: { className?: string }) {
  // Surfaces outside network settings render before the network owner mounts.
  return useContext(WorkbenchNetworkClientContext) ? <DaemonFailure className={className} /> : null;
}

function DaemonFailure({ className }: { className: string }) {
  const network = useWorkbenchNetwork();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  if (network.snapshot?.daemon?.state !== "failed") return null;

  async function retry() {
    setWorking(true);
    setError(null);
    try { await network.client.action({ action: "daemon-wake-retry" }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Daemon request failed."); }
    finally { setWorking(false); }
  }

  return <div role="alert" className={`space-y-1 text-[0.8rem] leading-5 ${className}`}>
    <p className="m-0 text-danger">
      The daemon failed{network.snapshot.daemonFailure ? `: ${network.snapshot.daemonFailure}` : "."} It retries automatically.
    </p>
    {network.snapshot.capabilities?.manageApp
      ? <button type="button" disabled={working} className="-mx-2 rounded px-2 py-1 text-accent hover:bg-fg/5 disabled:opacity-50"
        onClick={() => { void retry(); }}>Retry now</button> : null}
    {error ? <p className="m-0 text-danger">{error}</p> : null}
  </div>;
}

/*
 * Default export:
 * - WorkbenchNetworkAccessSettings: owner-selected DNS hosting, ownership handover and remote app grants.
 */
"use client";
import { useState } from "react";
import type { WorkbenchNetworkAction, WorkbenchNetworkGroup } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import WorkbenchPressDragMenu from "./WorkbenchPressDragMenu";
import WorkbenchPopover from "./WorkbenchPopover";
import WorkbenchIconButton from "./WorkbenchIconButton";
import WorkbenchModeRow from "./WorkbenchModeRow";
import WorkbenchCheckbox from "./WorkbenchCheckbox";
import PrimaryButton from "./PrimaryButton";
import { ChevronDownIcon, HomeIcon, LockIcon, SaveIcon, ResetIcon } from "./workbench-icons";

export default function WorkbenchNetworkAccessSettings() {
  const network = useWorkbenchNetwork();
  const [candidate, setCandidate] = useState<{ kind: "dns" | "owner"; nodeId: string } | null>(null);
  const [choices, setChoices] = useState<{ kind: "dns" | "owner"; anchor: HTMLElement } | null>(null);
  const [draft, setDraft] = useState<Pick<WorkbenchNetworkGroup, "revision" | "access" | "grants"> | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const snapshot = network.snapshot;
  const group = snapshot?.configuration.group;
  if (!snapshot || !group) return null;
  const members = snapshot.configuration.members;
  const owner = members.find(app => app.nodeId === group.ownerNodeId);
  const pendingTransfer = group.transfer?.phase !== "activated" ? group.transfer : undefined;
  const canManage = Boolean(snapshot.capabilities?.manageNetwork && !pendingTransfer);
  const busy = working || snapshot.busy || !!snapshot.change;
  const policy = draft ?? group;
  const stale = draft !== null && draft.revision !== group.revision;
  const selected = members.find(app => app.nodeId === candidate?.nodeId);
  function availability(nodeId: string) {
    if (nodeId === snapshot!.runtime.privateAccess.nodeId) return snapshot!.runtime.privateAccess.phase === "ready" ? "running" : "connecting";
    const device = snapshot!.runtime.privateAccess.devices?.find(device => device.nodeId === nodeId);
    return device ? device.online ? "node online" : "node offline" : "availability unknown";
  }
  const devices = [...(snapshot.runtime.privateAccess.devices ?? [])].filter(device => !members.some(app => app.nodeId === device.nodeId));
  for (const grant of policy.grants) {
    if (!devices.some(device => device.nodeId === grant.deviceNodeId)) devices.push({ nodeId: grant.deviceNodeId, name: grant.deviceNodeId, online: false });
  }
  devices.sort((left, right) => left.name.localeCompare(right.name));

  async function act(action: WorkbenchNetworkAction, applied: () => void) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); applied(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Network settings could not be updated."); }
    finally { setWorking(false); }
  }
  function choose(kind: "dns" | "owner", nodeId: string) {
    setChoices(null);
    if (nodeId !== (kind === "dns" ? group!.dnsNodeId : group!.ownerNodeId)) setCandidate({ kind, nodeId });
  }
  function saveAccess() {
    if (!draft || stale) return;
    void act({ action: "access", ...draft }, () => setDraft(null));
  }
  return <section className="space-y-4 rounded-2xl border border-[color-mix(in_srgb,var(--text)_12%,transparent)] p-4 text-sm">
    <h4 className="m-0 font-medium text-text">Network access</h4>
    {pendingTransfer ? <div className="space-y-2">
      <p className="m-0 text-fg/muted">Ownership handover to {members.find(app => app.nodeId === pendingTransfer.toNodeId)?.label ?? "the selected app"} is waiting to finish. DNS hosting and access grants are unchanged.</p>
      {snapshot.capabilities?.manageNetwork && pendingTransfer.fromNodeId === snapshot.runtime.privateAccess.nodeId
        ? <PrimaryButton disabled={busy} onClick={() => { void act({ action: "transfer-owner", nodeId: pendingTransfer.toNodeId }, () => setCandidate(null)); }}>Resume handover</PrimaryButton> : null}
    </div> : null}
    {!snapshot.capabilities?.manageNetwork ? <p className="m-0 text-fg/muted">Managed by {owner?.label ?? "the owner app"}. Change network settings on that computer. Local access here remains available.</p> : null}
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
      {(["dns", "owner"] as const).map(kind => {
        const id = kind === "dns" ? group.dnsNodeId : group.ownerNodeId;
        const app = members.find(member => member.nodeId === id);
        const name = app?.label ?? "unavailable";
        return <div key={kind} className="flex items-center gap-2">
          <span className="text-fg/muted">{kind === "dns" ? "Nameserver" : "Owner"}</span>
          {canManage && !busy ? <WorkbenchPressDragMenu label={`Choose ${kind === "dns" ? "nameserver app" : "network owner"}`}
            getItems={() => members.map(member => ({ id: member.nodeId, checked: member.nodeId === id, content: <span>{member.label}<span className="ml-2 text-xs text-fg/muted">{availability(member.nodeId)}</span></span> }))}
            onOpen={() => setChoices(null)} onSelect={nodeId => choose(kind, nodeId)} onActivate={anchor => setChoices({ kind, anchor })}>
            <span className="inline-flex items-center gap-1 font-medium">{name}<ChevronDownIcon className="size-3" /></span>
          </WorkbenchPressDragMenu> : <span className="font-medium text-text">{name}</span>}
          <span className="text-xs text-fg/muted">{availability(id)}</span>
        </div>;
      })}
    </div>
    {choices ? <WorkbenchPopover anchor={choices.anchor} label={`Choose ${choices.kind === "dns" ? "nameserver" : "owner"} app`}
      onClose={() => setChoices(null)} width={320} height={Math.min(320, 24 + members.length * 44)}>
      <div className="flex flex-col gap-1 overflow-y-auto p-2">
        {members.map(app => <PrimaryButton key={app.nodeId} disabled={busy} onClick={() => choose(choices.kind, app.nodeId)}>{app.label}<span className="ml-2 text-xs text-fg/muted">{availability(app.nodeId)}</span></PrimaryButton>)}
      </div>
    </WorkbenchPopover> : null}
    {candidate && selected ? <div className="space-y-3 rounded-xl bg-accent-soft/30 p-3">
      <p className="m-0 text-text">{candidate.kind === "dns" ? `Use ${selected.label} for DNS?` : `Transfer ownership to ${selected.label}?`}</p>
      <p className="m-0 text-fg/muted">{candidate.kind === "dns"
        ? `Update the wb.inthedark.boo nameserver in Tailscale to ${selected.addresses[0]}. Keep this app running for private names to resolve.`
        : "This transfers network management and certificate signing. App grants and the selected nameserver stay unchanged."}</p>
      <div className="flex gap-2">
        <PrimaryButton disabled={busy} pendingHalo={busy} onClick={() => {
          void act({ action: candidate.kind === "dns" ? "dns-app" : "transfer-owner", nodeId: selected.nodeId }, () => setCandidate(null));
        }}>{candidate.kind === "dns" ? "Use this app" : "Transfer ownership"}</PrimaryButton>
        <PrimaryButton disabled={busy} onClick={() => setCandidate(null)}>Cancel</PrimaryButton>
      </div>
    </div> : null}
    <div className="flex flex-wrap items-center gap-3">
    <span className="text-text">App access</span>
    <WorkbenchModeRow ariaLabel="Remote app access" value={policy.access} disabled={busy || !canManage || stale}
      options={[
        { value: "all", label: "all tailnet devices", ariaLabel: "Allow all tailnet devices", icon: <HomeIcon className="size-4" /> },
        { value: "selected", label: "selected devices", ariaLabel: "Allow selected devices per app", icon: <LockIcon className="size-4" /> },
      ] as const} onChange={access => {
        setDraft({ revision: group.revision, access, grants: policy.grants });
      }} />
    </div>
    {policy.access === "selected" ? <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead><tr><th className="py-2 pr-4 font-medium text-fg/muted">Device</th>{members.map(app => <th className="px-2 py-2 font-medium text-text" key={app.nodeId}>{app.label}</th>)}</tr></thead>
        <tbody>{devices.map(device => <tr key={device.nodeId}>
          <th className="py-2 pr-4 font-normal text-text">{device.name}{!device.online ? <span className="ml-2 text-xs text-fg/muted">offline</span> : null}</th>
          {members.map(app => {
            const ownApp = device.nodeId === (app.nodeId === snapshot.runtime.privateAccess.nodeId
              ? snapshot.runtime.host?.nodeId ?? app.hostNodeId : app.hostNodeId);
            return <td key={app.nodeId} className="px-2 py-1" title={ownApp ? "Always allowed on this device" : undefined}><WorkbenchCheckbox
            label={<span className="sr-only">{device.name} access to {app.label}{ownApp ? " - Always allowed on this device" : ""}</span>}
            checked={ownApp || policy.grants.some(grant => grant.deviceNodeId === device.nodeId && grant.appNodeId === app.nodeId)}
            disabled={ownApp || busy || !canManage || stale} onChange={checked => {
              const grants = policy.grants.filter(grant => grant.deviceNodeId !== device.nodeId || grant.appNodeId !== app.nodeId);
              if (checked) grants.push({ deviceNodeId: device.nodeId, appNodeId: app.nodeId });
              setDraft({ revision: group.revision, access: "selected", grants });
            }} /></td>;
          })}
        </tr>)}</tbody>
      </table>
      {!devices.length ? <p className="text-fg/muted">No browsing devices are currently visible to this app on Tailscale.</p> : null}
    </div> : null}
    {stale ? <p className="m-0 text-danger" role="alert">Network settings changed while you were editing. Reset your draft before saving.</p> : null}
    {snapshot.runtime.privateAccess.pendingUpdates?.length ? <p className="m-0 text-fg/muted">Updates are still pending on {snapshot.runtime.privateAccess.pendingUpdates.length} apps. Existing policy remains in force there.</p> : null}
    {snapshot.capabilities?.manageApp && snapshot.runtime.privateAccess.nodeId && group.dnsNodeId !== snapshot.runtime.privateAccess.nodeId ? <div className="flex flex-col gap-2">
      <p className="m-0 text-fg/muted">Remove this private address and keep using the tailnet IP address. Device trust and the app's Tailscale identity stay unchanged.</p>
      <PrimaryButton disabled={busy || !snapshot.localPort || !snapshot.capabilities.settingsApply}
        onClick={() => {
          setWorking(true);
          setError("");
          void network.client.changeSettings({ mode: "tailnet-ip", localPort: snapshot.localPort!.currentPort,
            tailnetPort: snapshot.configuration.hostServe.port, removeRegistration: true })
            .catch(failure => setError(failure instanceof Error ? failure.message : "Private address could not be removed."))
            .finally(() => setWorking(false));
        }}>Remove private address</PrimaryButton>
    </div> : null}
    {error ? <p className="m-0 text-danger" role="alert">{error}</p> : null}
    {draft ? <div className="flex gap-2">
      <WorkbenchIconButton label="Save access" disabled={busy || stale || !canManage} onClick={saveAccess}><SaveIcon className="size-4" /></WorkbenchIconButton>
      <WorkbenchIconButton label="Reset access changes" disabled={busy} onClick={() => setDraft(null)}><ResetIcon className="size-4" /></WorkbenchIconButton>
    </div> : null}
  </section>;
}

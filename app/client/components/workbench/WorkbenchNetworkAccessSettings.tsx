/*
 * Default export:
 * - WorkbenchNetworkAccessSettings: network rule rows for DNS hosting, ownership handover, machine removal and per-app device grants.
 */
"use client";
import { useState } from "react";
import type { WorkbenchNetworkAction, WorkbenchNetworkGroup } from "workbench-shared/http/workbench-network";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import PressDragMenu from "../ui/PressDragMenu";
import IconButton from "../ui/IconButton";
import RadioRow from "../ui/RadioRow";
import WorkbenchCheckbox from "./WorkbenchCheckbox";
import PrimaryButton from "../ui/PrimaryButton";
import { SettingsCardRow } from "../ui/SettingsCard";
import { ChevronDownIcon, HomeIcon, LockIcon, SaveIcon, ResetIcon, XIcon } from "./workbench-icons";

type AvailabilityState = "running" | "connecting" | "node online" | "node offline" | "availability unknown";

function Availability({ state }: { state: AvailabilityState }) {
  const tone = state === "running" || state === "node online" ? "bg-success"
    : state === "node offline" ? "bg-danger" : "bg-fg/40";
  return <span role="img" aria-label={state} title={state} className={`inline-block size-1.5 shrink-0 rounded-full ${tone}`} />;
}

export default function WorkbenchNetworkAccessSettings() {
  const network = useWorkbenchNetwork();
  const [candidate, setCandidate] = useState<{ kind: "dns" | "owner" | "remove"; nodeId: string } | null>(null);
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
  const self = snapshot.runtime.privateAccess.nodeId;
  /** The owner edits every app's column; any other app edits only its own. */
  const canEdit = (appNodeId: string) => canManage || Boolean(snapshot.capabilities?.manageApp && !pendingTransfer && appNodeId === self);
  const busy = working || snapshot.busy || !!snapshot.change;
  const policy = draft ?? group;
  const stale = draft !== null && draft.revision !== group.revision;
  const selected = members.find(app => app.nodeId === candidate?.nodeId);
  function availability(nodeId: string): AvailabilityState {
    if (nodeId === snapshot!.runtime.privateAccess.nodeId) return snapshot!.runtime.privateAccess.phase === "ready" ? "running" : "connecting";
    const device = snapshot!.runtime.privateAccess.devices?.find(device => device.nodeId === nodeId);
    return device ? device.online ? "node online" : "node offline" : "availability unknown";
  }
  const devices = [...(snapshot.runtime.privateAccess.devices ?? [])].filter(device => !members.some(app => app.nodeId === device.nodeId));
  for (const grant of policy.grants) {
    if (!devices.some(device => device.nodeId === grant.deviceNodeId)) devices.push({ nodeId: grant.deviceNodeId, name: grant.deviceNodeId, online: false });
  }
  /** A device hosting a Workbench app shows that app's configured device name, matching its column. */
  const deviceLabel = (device: { nodeId: string; name: string }) => members.find(app => device.nodeId === (
    app.nodeId === snapshot.runtime.privateAccess.nodeId ? snapshot.runtime.host?.nodeId ?? app.hostNodeId : app.hostNodeId))?.label ?? device.name;
  devices.sort((left, right) => deviceLabel(left).localeCompare(deviceLabel(right)));

  async function act(action: WorkbenchNetworkAction, applied: () => void) {
    setWorking(true);
    setError("");
    try { await network.client.action(action); applied(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Network settings could not be updated."); }
    finally { setWorking(false); }
  }
  function choose(kind: "dns" | "owner", nodeId: string) {
    if (nodeId !== (kind === "dns" ? group!.dnsNodeId : group!.ownerNodeId)) setCandidate({ kind, nodeId });
  }
  function saveAccess() {
    if (!draft || stale) return;
    void act(canManage ? { action: "access", ...draft } : {
      action: "app-access", revision: draft.revision,
      deviceNodeIds: draft.grants.filter(grant => grant.appNodeId === self).map(grant => grant.deviceNodeId),
    }, () => setDraft(null));
  }
  const confirmation = candidate?.kind === "dns" ? {
    title: `Use ${selected?.label} for DNS?`, action: "Use this app",
    detail: `Update the wb.inthedark.boo nameserver in Tailscale to ${selected?.addresses[0]}. Keep this app running for private names to resolve.`,
  } : candidate?.kind === "owner" ? {
    title: `Transfer ownership to ${selected?.label}?`, action: "Transfer",
    detail: "This transfers network management and certificate signing. App grants and the selected nameserver stay unchanged.",
  } : { title: `Remove ${selected?.label} from the network?`, action: "Remove", detail: "Its access rules are removed with it." };
  return <>
    {pendingTransfer ? <SettingsCardRow label="Handover">
      <span className="min-w-0 flex-1 basis-60 text-fg/muted">Ownership handover to {members.find(app => app.nodeId === pendingTransfer.toNodeId)?.label ?? "the selected app"} is waiting to finish. DNS hosting and access grants are unchanged.</span>
      {snapshot.capabilities?.manageNetwork && pendingTransfer.fromNodeId === snapshot.runtime.privateAccess.nodeId
        ? <PrimaryButton shape="compact" disabled={busy} onClick={() => { void act({ action: "transfer-owner", nodeId: pendingTransfer.toNodeId }, () => setCandidate(null)); }}>Resume handover</PrimaryButton> : null}
    </SettingsCardRow> : null}
    {!snapshot.capabilities?.manageNetwork ? <SettingsCardRow>
      <span className="text-fg/muted">Managed by {owner?.label ?? "the owner app"}. {policy.access === "selected"
        ? "You can change which devices reach this app." : "Change network settings on that computer."}</span>
    </SettingsCardRow> : null}
    <SettingsCardRow label="Nameserver">
      {(["dns", "owner"] as const).map(kind => {
        const id = kind === "dns" ? group.dnsNodeId : group.ownerNodeId;
        const name = members.find(member => member.nodeId === id)?.label ?? "Unavailable";
        return <span key={kind} className={`flex items-center gap-2 ${kind === "owner" ? "ml-6" : ""}`}>
          {kind === "owner" ? <span className="text-fg/muted">Owner</span> : null}
          {canManage && !busy ? <PressDragMenu label={`Choose ${kind === "dns" ? "nameserver app" : "network owner"}`}
            triggerClassName="-mx-2.5 text-text"
            items={members.map(member => ({ id: member.nodeId, checked: member.nodeId === id, content: <span className="inline-flex items-center gap-2">{member.label}<Availability state={availability(member.nodeId)} /></span> }))}
            onSelect={nodeId => choose(kind, nodeId)}>
            <span className="font-medium">{name}</span><ChevronDownIcon className="size-3.5 text-fg/muted" />
          </PressDragMenu> : <span className="font-medium text-text">{name}</span>}
          <Availability state={availability(id)} />
        </span>;
      })}
    </SettingsCardRow>
    <SettingsCardRow label="Machines">
      <span className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">{members.map(member => <span key={member.nodeId} className="inline-flex items-center gap-1.5">
        <span className="font-medium text-text">{member.label}</span>
        <Availability state={availability(member.nodeId)} />
        {canManage && member.nodeId !== group.ownerNodeId && member.nodeId !== group.dnsNodeId
          ? <IconButton size="small" display="hover-border" label={`Remove ${member.label} from the network`} disabled={busy}
            onClick={() => setCandidate({ kind: "remove", nodeId: member.nodeId })}><XIcon className="size-3.5" /></IconButton> : null}
      </span>)}</span>
    </SettingsCardRow>
    {candidate && selected ? <SettingsCardRow>
      <div className="min-w-0 flex-1 basis-72 space-y-1">
        <p className="m-0 font-medium text-text">{confirmation.title}</p>
        <p className="m-0 text-fg/muted">{confirmation.detail}</p>
      </div>
      <PrimaryButton shape="compact" disabled={busy} pendingHalo={busy} onClick={() => {
        void act({ action: candidate.kind === "dns" ? "dns-app" : candidate.kind === "owner" ? "transfer-owner" : "remove-member", nodeId: selected.nodeId },
          () => setCandidate(null));
      }}>{confirmation.action}</PrimaryButton>
      <PrimaryButton shape="compact" disabled={busy} onClick={() => setCandidate(null)}>Cancel</PrimaryButton>
    </SettingsCardRow> : null}
    <SettingsCardRow label="Allowed devices">
      <RadioRow ariaLabel="Remote app access" size="comfortable" value={policy.access} disabled={busy || !canManage || stale}
        options={[
          { value: "all", label: "All tailnet devices", ariaLabel: "Allow all tailnet devices", icon: <HomeIcon className="size-4" /> },
          { value: "selected", label: "Selected devices", ariaLabel: "Allow selected devices per app", icon: <LockIcon className="size-4" /> },
        ] as const} onChange={access => {
          setDraft({ revision: group.revision, access, grants: policy.grants });
        }} />
    </SettingsCardRow>
    {policy.access === "selected" ? <SettingsCardRow><div className="scrollbar-hover-reveal w-full overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead><tr><th className="py-1.5 pl-2 pr-4 font-normal text-fg/muted">Device app can access...</th>{members.map(app => <th className="px-2 py-1.5 text-center font-normal text-fg/muted" key={app.nodeId}>{app.label}</th>)}</tr></thead>
        <tbody className="[&>tr:nth-child(odd)>*]:bg-fg/4 [&>tr>*:first-child]:rounded-l-lg [&>tr>*:last-child]:rounded-r-lg">{devices.map(device => <tr key={device.nodeId}>
          <th className="py-1 pl-2 pr-4 font-normal text-text">{deviceLabel(device)}{!device.online ? <span className="ml-2 text-xs text-fg/muted">offline</span> : null}</th>
          {members.map(app => {
            const ownApp = device.nodeId === (app.nodeId === snapshot.runtime.privateAccess.nodeId
              ? snapshot.runtime.host?.nodeId ?? app.hostNodeId : app.hostNodeId);
            return <td key={app.nodeId} className="px-2 py-1 text-center [&_label]:justify-center" title={ownApp ? "Always allowed on this device" : undefined}><WorkbenchCheckbox
            label={<span className="sr-only">{deviceLabel(device)} access to {app.label}{ownApp ? " - Always allowed on this device" : ""}</span>}
            checked={ownApp || policy.grants.some(grant => grant.deviceNodeId === device.nodeId && grant.appNodeId === app.nodeId)}
            disabled={ownApp || busy || !canEdit(app.nodeId) || stale} onChange={checked => {
              const grants = policy.grants.filter(grant => grant.deviceNodeId !== device.nodeId || grant.appNodeId !== app.nodeId);
              if (checked) grants.push({ deviceNodeId: device.nodeId, appNodeId: app.nodeId });
              setDraft({ revision: group.revision, access: "selected", grants });
            }} /></td>;
          })}
        </tr>)}</tbody>
      </table>
      {!devices.length ? <p className="m-0 py-1 text-fg/muted">No browsing devices are visible to this app on Tailscale.</p> : null}
    </div></SettingsCardRow> : null}
    {stale || snapshot.runtime.privateAccess.pendingUpdates?.length || error ? <SettingsCardRow>
      {stale ? <p className="m-0 text-danger" role="alert">Network settings changed while you were editing. Reset your draft before saving.</p> : null}
      {snapshot.runtime.privateAccess.pendingUpdates?.length ? <p className="m-0 text-fg/muted">Updates are still pending on {snapshot.runtime.privateAccess.pendingUpdates.length} apps. Existing policy remains in force there.</p> : null}
      {error ? <p className="m-0 text-danger" role="alert">{error}</p> : null}
    </SettingsCardRow> : null}
    {draft ? <SettingsCardRow>
      <span className="flex-1 text-fg/muted">Unsaved access changes</span>
      <IconButton size="small" display="hover-border" label="Save access" disabled={busy || stale || !(self && canEdit(self))} onClick={saveAccess}><SaveIcon className="size-4" /></IconButton>
      <IconButton size="small" display="hover-border" label="Reset access changes" disabled={busy} onClick={() => setDraft(null)}><ResetIcon className="size-4" /></IconButton>
    </SettingsCardRow> : null}
    {snapshot.capabilities?.manageApp && snapshot.runtime.privateAccess.nodeId && group.dnsNodeId !== snapshot.runtime.privateAccess.nodeId ? <SettingsCardRow label="Private address">
      <span className="min-w-0 flex-1 basis-60 text-fg/muted">Drop this app's private name and keep using its tailnet IP. Device trust stays.</span>
      <PrimaryButton shape="compact" disabled={busy || !snapshot.localPort || !snapshot.capabilities.settingsApply}
        onClick={() => {
          setWorking(true);
          setError("");
          void network.client.changeSettings({ mode: "tailnet-ip", localPort: snapshot.localPort!.currentPort,
            tailnetPort: snapshot.configuration.hostServe.port, removeRegistration: true })
            .catch(failure => setError(failure instanceof Error ? failure.message : "Private address could not be removed."))
            .finally(() => setWorking(false));
        }}>Remove</PrimaryButton>
    </SettingsCardRow> : null}
  </>;
}

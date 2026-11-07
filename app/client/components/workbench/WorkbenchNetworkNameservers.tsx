/*
 * Exports:
 * - default WorkbenchNetworkNameservers: show replicated DNS addresses and explicit multi-machine Tailscale setup.
 */
"use client";
import { useWorkbenchNetwork } from "../../workbench/app/WorkbenchNetworkClient";
import WorkbenchCopyButton from "./WorkbenchCopyButton";
import WorkbenchLinkButton from "./WorkbenchLinkButton";
import { ExternalLinkIcon } from "./workbench-icons";

export default function WorkbenchNetworkNameservers() {
  const { snapshot } = useWorkbenchNetwork();
  if (!snapshot?.configuration.group) return null;
  const setupDefault = snapshot.configuration.group.dnsNodeId;
  const members = snapshot.configuration.members.filter(member => member.published !== false && member.addresses.length)
    .sort((left, right) => Number(right.nodeId === setupDefault) - Number(left.nodeId === setupDefault)
      || left.label.localeCompare(right.label));
  const pending = snapshot.runtime.privateAccess.pendingUpdates ?? [];
  const machineCount = new Set(members.map(member => member.hostNodeId ?? member.nodeId)).size;
  return <div className="min-w-0 flex-1 space-y-2 text-sm">
    <p className="m-0 text-fg/muted">In Tailscale DNS settings, add nameservers from at least two different computers, each restricted to <strong className="font-medium text-text">wb.inthedark.boo</strong>. Keep at least one running. Resolver order is not guaranteed.</p>
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{members.map(member => <li key={member.nodeId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium text-text">{member.label}</span>
      <code className="select-all text-text">{member.addresses[0]}</code>
      <WorkbenchCopyButton label={`Copy ${member.label} nameserver address`} text={member.addresses[0]!} />
      {member.nodeId === setupDefault ? <span className="text-fg/muted">Setup default</span> : null}
      {pending.includes(member.nodeId) ? <span className="text-danger">Directory update pending; answers may be out of date</span> : null}
    </li>)}</ul>
    {machineCount < 2 ? <p className="m-0 text-fg/muted">{members.length ? "Only one computer is listed for DNS setup. Add a private member on another computer to avoid a single point of failure." : "Waiting for a private member's nameserver address."}</p> : null}
    <p className="m-0 text-fg/muted">Update each nameserver's Workbench before adding it. These addresses are not added to Tailscale automatically; remove a retired machine from Tailscale DNS too.</p>
    <WorkbenchLinkButton href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">Open Tailscale DNS<ExternalLinkIcon className="size-4" /></WorkbenchLinkButton>
  </div>;
}

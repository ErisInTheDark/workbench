/*
 * Exports:
 * - NetworkDnsCoverage: how well the tailnet's private-name nameservers cover the network's computers.
 * - networkDnsCoverage: judge one network snapshot; null until the sidecar has read the tailnet's DNS routes.
 * - TAILSCALE_DNS_ADMIN_URL: where the tailnet's nameservers are edited.
 */
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";

export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

export interface NetworkDnsCoverage {
  /** `broken`: no listed nameserver is a reachable member, so private names fail now. `fragile`: one outage away. */
  verdict: "healthy" | "fragile" | "broken";
  /** One row per computer: listed ones first in Tailscale's order, then unlisted members; strangers carry a null label. */
  rows: Array<{ address: string; label: string | null; listed: boolean; online: boolean | null }>;
  /** The online, unlisted member to add next; null when nothing useful can be added. */
  suggestion: { label: string; address: string } | null;
}

export function networkDnsCoverage(snapshot: WorkbenchNetworkSnapshot): NetworkDnsCoverage | null {
  const route = snapshot.runtime.privateAccess.tailnetDns;
  if (!route || !snapshot.configuration.group) return null;
  const published = snapshot.configuration.members.filter(member => member.published !== false && member.addresses.length);
  const owner = new Map(published.flatMap(member => member.addresses.map(address => [address, member] as const)));
  const reachability = new Map((route.members ?? []).map(entry => [entry.address, entry.online]));
  const listed = new Set(route.nameservers.map(nameserver => nameserver.address));
  const rows = [
    ...route.nameservers.map(nameserver => ({
      address: nameserver.address, label: owner.get(nameserver.address)?.label ?? null, listed: true, online: nameserver.online,
    })),
    ...published.filter(member => !member.addresses.some(address => listed.has(address))).map(member => ({
      address: member.addresses[0]!, label: member.label, listed: false, online: reachability.get(member.addresses[0]!) ?? null,
    })),
  ];
  const reachable = route.nameservers.filter(nameserver => nameserver.online !== false && owner.has(nameserver.address));
  const machines = new Set(reachable.map(nameserver => {
    const member = owner.get(nameserver.address)!;
    return member.hostNodeId ?? member.nodeId;
  }));
  const candidate = rows.find(row => !row.listed && row.online && row.label
    && !machines.has(owner.get(row.address)!.hostNodeId ?? owner.get(row.address)!.nodeId));
  const tidy = rows.every(row => !row.listed || (row.label && row.online !== false));
  return {
    verdict: !reachable.length ? "broken" : machines.size < 2 || !tidy ? "fragile" : "healthy",
    rows,
    suggestion: candidate?.label ? { label: candidate.label, address: candidate.address } : null,
  };
}

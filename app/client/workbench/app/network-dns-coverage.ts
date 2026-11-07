/*
 * Exports:
 * - NetworkDnsCoverage: how well the tailnet's private-name nameservers cover the network's members.
 * - networkDnsCoverage: judge one network snapshot; null until the sidecar has read the tailnet's DNS routes.
 * - TAILSCALE_DNS_ADMIN_URL: where the tailnet's nameservers are edited.
 */
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";

export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

export interface NetworkDnsCoverage {
  /** `broken`: no listed nameserver is online, so private names fail now. `fragile`: one outage away from that. */
  verdict: "healthy" | "fragile" | "broken";
  /** Each published member's first address and whether the tailnet lists it. */
  members: Array<{ nodeId: string; label: string; address: string; listed: boolean }>;
  /** Listed addresses that are offline, and listed addresses no member owns. */
  offline: string[];
  unknown: string[];
  /** One short sentence explaining the verdict; null when healthy. */
  problem: string | null;
}

export function networkDnsCoverage(snapshot: WorkbenchNetworkSnapshot): NetworkDnsCoverage | null {
  const route = snapshot.runtime.privateAccess.tailnetDns;
  if (!route || !snapshot.configuration.group) return null;
  const published = snapshot.configuration.members.filter(member => member.published !== false && member.addresses.length);
  const listed = new Map(route.nameservers.map(nameserver => [nameserver.address, nameserver]));
  const owner = new Map(published.flatMap(member => member.addresses.map(address => [address, member] as const)));
  const members = published.map(member => ({
    nodeId: member.nodeId, label: member.label, address: member.addresses[0]!,
    listed: member.addresses.some(address => listed.has(address)),
  }));
  const offline = route.nameservers.filter(nameserver => nameserver.online === false).map(nameserver => nameserver.address);
  const unknown = route.nameservers.filter(nameserver => !owner.has(nameserver.address)).map(nameserver => nameserver.address);
  const reachable = route.nameservers.filter(nameserver => nameserver.online !== false && owner.has(nameserver.address));
  const machines = new Set(reachable.map(nameserver => {
    const member = owner.get(nameserver.address)!;
    return member.hostNodeId ?? member.nodeId;
  }));
  const problem = !route.nameservers.length ? "Tailscale DNS has no nameserver for wb.inthedark.boo, so private names do not resolve."
    : !reachable.length ? offline.length === route.nameservers.length
      ? "Every nameserver Tailscale DNS lists for wb.inthedark.boo is offline, so private names do not resolve."
      : "No Workbench computer Tailscale DNS lists for wb.inthedark.boo is reachable, so private names may not resolve."
      : machines.size < 2 ? "Tailscale DNS lists only one reachable computer for wb.inthedark.boo; private names stop resolving if it goes offline."
        : offline.length ? "Tailscale DNS lists an offline nameserver for wb.inthedark.boo."
          : unknown.length ? "Tailscale DNS lists a nameserver for wb.inthedark.boo that is no longer a Workbench computer."
            : null;
  return {
    verdict: !reachable.length ? "broken" : problem ? "fragile" : "healthy",
    members, offline, unknown, problem,
  };
}

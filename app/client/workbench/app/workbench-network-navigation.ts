/*
 * Exports:
 * - NetworkHandoff: private one-use browser receipt for finishing or cancelling settings.
 * - NetworkUpgrade: selected higher mode to follow after a successful settings change.
 * - networkNavigationUrl: replace an origin while preserving route and browser identity.
 * - consumeNetworkHandoff: validate and remove a receipt before same-origin confirmation.
 */
import { z } from "zod";
import { WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER } from "../state/workbench-browser-state-identity";

const parameter = "workbenchNetworkHandoff";
const upgradeParameter = "workbenchNetworkUpgrade";
const upgradeSchema = z.enum(["tailnet-ip", "tailnet-service"]);
export type NetworkUpgrade = z.infer<typeof upgradeSchema>;
const receiptSchema = z.object({
  token: z.uuid(), returning: z.boolean(), manual: z.boolean().optional(), upgrade: upgradeSchema.optional(),
}).strict();
export type NetworkHandoff = z.infer<typeof receiptSchema>;

export function networkNavigationUrl(href: string, origin: string, receipt?: NetworkHandoff, browserStateId?: string, upgrade?: NetworkUpgrade) {
  const destination = new URL(origin);
  if (!["http:", "https:"].includes(destination.protocol) || destination.origin !== origin) throw new Error("Expected a web origin.");
  const current = new URL(href);
  destination.pathname = current.pathname;
  destination.search = current.search;
  destination.hash = current.hash;
  destination.searchParams.delete(parameter);
  if (receipt) destination.searchParams.set(parameter, JSON.stringify(receiptSchema.parse(receipt)));
  destination.searchParams.delete(upgradeParameter);
  if (upgrade) destination.searchParams.set(upgradeParameter, upgrade);
  if (browserStateId) destination.searchParams.set(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER, browserStateId);
  return destination.href;
}

export function consumeNetworkHandoff(href: string): { href: string; receipt: NetworkHandoff | null; upgrade: NetworkUpgrade | null } {
  const url = new URL(href);
  const encoded = url.searchParams.get(parameter);
  const encodedUpgrade = url.searchParams.get(upgradeParameter);
  url.searchParams.delete(parameter);
  url.searchParams.delete(upgradeParameter);
  try {
    const receipt = encoded === null ? null : receiptSchema.parse(JSON.parse(encoded));
    const upgrade = encodedUpgrade === null ? null : upgradeSchema.parse(encodedUpgrade);
    return { href: url.href, receipt, upgrade };
  } catch {
    throw new Error("The network handoff link is invalid. Return to the original app address.");
  }
}

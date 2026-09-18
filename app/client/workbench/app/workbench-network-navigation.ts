/*
 * Exports:
 * - NetworkHandoff: private one-use browser receipt for finishing or cancelling settings.
 * - networkNavigationUrl: replace an origin while preserving route and browser identity.
 * - consumeNetworkHandoff: validate and remove a receipt before same-origin confirmation.
 */
import { z } from "zod";
import { WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER } from "../state/workbench-browser-state-identity";

const parameter = "workbenchNetworkHandoff";
const receiptSchema = z.object({
  token: z.uuid(), returning: z.boolean(), manual: z.boolean().optional(), panel: z.literal("access").optional(),
}).strict();
export type NetworkHandoff = z.infer<typeof receiptSchema>;

export function networkNavigationUrl(href: string, origin: string, receipt?: NetworkHandoff, browserStateId?: string) {
  const destination = new URL(origin);
  if (!["http:", "https:"].includes(destination.protocol) || destination.origin !== origin) throw new Error("Expected a web origin.");
  const current = new URL(href);
  destination.pathname = current.pathname;
  destination.search = current.search;
  destination.hash = current.hash;
  destination.searchParams.delete(parameter);
  if (receipt) destination.searchParams.set(parameter, JSON.stringify(receiptSchema.parse(receipt)));
  if (receipt?.panel) destination.searchParams.set("workbenchNetworkPanel", receipt.panel);
  if (browserStateId) destination.searchParams.set(WORKBENCH_BROWSER_STATE_TRANSFER_PARAMETER, browserStateId);
  return destination.href;
}

export function consumeNetworkHandoff(href: string): { href: string; receipt: NetworkHandoff | null } {
  const url = new URL(href);
  const encoded = url.searchParams.get(parameter);
  url.searchParams.delete(parameter);
  if (encoded === null) return { href: url.href, receipt: null };
  try {
    const receipt = receiptSchema.parse(JSON.parse(encoded));
    return { href: url.href, receipt };
  } catch {
    throw new Error("The network handoff link is invalid. Return to the original app address.");
  }
}

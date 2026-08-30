/*
 * Exports:
 * - ComposerProfilePersistence: typed browser boundary for daemon-owned composer profiles. Keywords: composer, profile, daemon, api.
 * - createComposerProfilePersistence: create the stateless `/api/composer-profiles` adapter. Keywords: composer, profile, fetch, boundary.
 */
import type { WorkbenchComposerProfile, WorkbenchComposerProfileMutation, WorkbenchComposerProfileStorePayload } from "../../types";

export interface ComposerProfilePersistence {
  mutate: (mutation: WorkbenchComposerProfileMutation) => Promise<WorkbenchComposerProfileStorePayload>;
  read: () => Promise<WorkbenchComposerProfileStorePayload>;
}

async function requestProfiles(method: "GET" | "POST", body?: object) {
  const response = await fetch("/api/composer-profiles", {
    cache: "no-store",
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
  const payload = await response.json() as WorkbenchComposerProfileStorePayload & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Unable to persist composer profiles.");
  return payload;
}

export function createComposerProfilePersistence(): ComposerProfilePersistence {
  return {
    mutate: async (mutation) => await requestProfiles("POST", { action: "mutate", mutation }),
    read: async () => await requestProfiles("GET"),
  };
}

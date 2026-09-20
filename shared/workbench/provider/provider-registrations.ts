/*
 * Exports:
 * - default providerRegistrations: installed provider keys and graph registrations.
 * - WorkbenchProviderKey: installed provider key.
 * - WorkbenchProviderRegistration: installed definition registration.
 * - installedProviderKeys: providers included in this build, not all retained storage identities.
 * - defaultProviderKey: installed default for new provider selection.
 */
const providerRegistrations = {
  codex: "codexProvider",
  opencode: "openCodeProvider",
} as const;
export default providerRegistrations;
export type WorkbenchProviderKey = keyof typeof providerRegistrations;
export const defaultProviderKey: WorkbenchProviderKey = "codex";
export type WorkbenchProviderRegistration = typeof providerRegistrations[WorkbenchProviderKey];
export const installedProviderKeys = Object.freeze(Object.keys(providerRegistrations) as WorkbenchProviderKey[]);

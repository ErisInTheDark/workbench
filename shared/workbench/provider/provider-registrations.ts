/*
 * Exports:
 * - default providerRegistrations: installed provider keys and graph registrations.
 * - WorkbenchProviderKey: installed provider key.
 * - WorkbenchProviderRegistration: installed definition registration.
 * - installedProviderKeys: providers included in this build, not all retained storage identities.
 */
const providerRegistrations = { codex: "codexProvider" } as const;
export default providerRegistrations;
export type WorkbenchProviderKey = keyof typeof providerRegistrations;
export type WorkbenchProviderRegistration = typeof providerRegistrations[WorkbenchProviderKey];
export const installedProviderKeys = Object.freeze(Object.keys(providerRegistrations) as WorkbenchProviderKey[]);

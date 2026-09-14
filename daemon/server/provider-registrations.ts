/*
 * Exports:
 * - default providerRegistrations: installed provider keys and graph registrations.
 * - WorkbenchProviderKey: installed provider key.
 * - WorkbenchProviderRegistration: installed definition registration.
 */
const providerRegistrations = { codex: "codexProvider" } as const;
export default providerRegistrations;
export type WorkbenchProviderKey = keyof typeof providerRegistrations;
export type WorkbenchProviderRegistration = typeof providerRegistrations[WorkbenchProviderKey];

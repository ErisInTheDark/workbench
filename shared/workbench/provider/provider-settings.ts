/*
 * Exports:
 * - WorkbenchSandboxNetworkSnapshot/WorkbenchSandboxNetworkSetting: stored resolution and provider-declared display data.
 * - WorkbenchSandboxNetworkUpdate/WorkbenchSandboxNetworkUpdateSchema: validated global/project mutation intent.
 * - WorkbenchSandboxNetworkSettingsResponse/WorkbenchSandboxNetworkSettingsResponseSchema: declared settings returned to the browser.
 * - WorkbenchProviderSandboxNetwork: optional provider-owned setting operations.
 */
import { z } from "zod";
import { ProviderKeySchema } from "./provider-key";

const snapshot = z.object({
  effectiveEnabled: z.boolean(),
  globalEnabled: z.boolean(),
  projectId: z.string(),
  projectOverride: z.boolean().nullable(),
});
const setting = snapshot.extend({ label: z.string() });

export type WorkbenchSandboxNetworkSnapshot = z.infer<typeof snapshot>;
export type WorkbenchSandboxNetworkSetting = z.infer<typeof setting>;
export const WorkbenchSandboxNetworkUpdateSchema = z.object({
  enabled: z.boolean().nullable(),
  projectId: z.string().min(1),
  provider: ProviderKeySchema,
  scope: z.enum(["global", "project"]),
}).refine(input => input.scope !== "global" || input.enabled !== null, {
  message: "A global sandbox network update requires a boolean enabled value.",
});
export type WorkbenchSandboxNetworkUpdate = z.infer<typeof WorkbenchSandboxNetworkUpdateSchema>;
export const WorkbenchSandboxNetworkSettingsResponseSchema = z.object({
  data: z.array(setting.extend({ provider: ProviderKeySchema })),
});
export type WorkbenchSandboxNetworkSettingsResponse = z.infer<typeof WorkbenchSandboxNetworkSettingsResponseSchema>;
export interface WorkbenchProviderSandboxNetwork {
  read(projectId: string): Promise<WorkbenchSandboxNetworkSetting | null>;
  update(input: Omit<WorkbenchSandboxNetworkUpdate, "provider">): Promise<WorkbenchSandboxNetworkSetting>;
}

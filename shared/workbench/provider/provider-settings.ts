/*
 * Exports:
 * - WorkbenchSandboxNetworkSnapshot/WorkbenchSandboxNetworkSetting: stored resolution and provider-declared display data.
 * - WorkbenchSandboxNetworkUpdate/WorkbenchSandboxNetworkUpdateIntent/WorkbenchSandboxNetworkUpdateSchema: validated global/project mutation intent.
 * - WorkbenchSandboxNetworkSettingsResponse/WorkbenchSandboxNetworkSettingsResponseSchema: declared settings returned to the browser.
 * - WorkbenchProviderSandboxNetwork: optional provider-owned setting operations.
 */
import { z } from "zod";
import { ProviderKeySchema } from "./provider-key";

const snapshot = z.object({
  effectiveEnabled: z.boolean(),
  globalEnabled: z.boolean(),
  projectId: z.string().nullable(),
  projectOverride: z.boolean().nullable(),
});
const setting = snapshot.extend({ label: z.string() });

export type WorkbenchSandboxNetworkSnapshot = z.infer<typeof snapshot>;
export type WorkbenchSandboxNetworkSetting = z.infer<typeof setting>;
export const WorkbenchSandboxNetworkUpdateSchema = z.discriminatedUnion("scope", [
  z.object({
    enabled: z.boolean(),
    projectId: z.string().min(1).optional(),
    provider: ProviderKeySchema,
    scope: z.literal("global"),
  }),
  z.object({
    enabled: z.boolean().nullable(),
    projectId: z.string().min(1),
    provider: ProviderKeySchema,
    scope: z.literal("project"),
  }),
]);
export type WorkbenchSandboxNetworkUpdate = z.infer<typeof WorkbenchSandboxNetworkUpdateSchema>;
export type WorkbenchSandboxNetworkUpdateIntent =
  | Omit<Extract<WorkbenchSandboxNetworkUpdate, { scope: "global" }>, "provider">
  | Omit<Extract<WorkbenchSandboxNetworkUpdate, { scope: "project" }>, "provider">;
export const WorkbenchSandboxNetworkSettingsResponseSchema = z.object({
  data: z.array(setting.extend({ provider: ProviderKeySchema })),
});
export type WorkbenchSandboxNetworkSettingsResponse = z.infer<typeof WorkbenchSandboxNetworkSettingsResponseSchema>;
export interface WorkbenchProviderSandboxNetwork {
  read(projectId: string | null): Promise<WorkbenchSandboxNetworkSetting | null>;
  update(input: WorkbenchSandboxNetworkUpdateIntent): Promise<WorkbenchSandboxNetworkSetting>;
}

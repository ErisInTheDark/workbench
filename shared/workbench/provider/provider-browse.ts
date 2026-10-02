/*
 * Exports:
 * - WorkbenchScreenshotDelivery: acknowledged screenshot delivery through the provider's supported mechanism.
 * - WorkbenchProviderBrowse: deliver a Browse screenshot to the provider's model; Workbench records Browse results itself.
 */
export type WorkbenchScreenshotDelivery =
  | { kind: "injected"; acceptedAt: number; turnId: string }
  | { kind: "steered"; turnId: string };

export interface WorkbenchProviderBrowse {
  screenshot(input: { threadId: string; turnId: string; imageUrl: string }): Promise<WorkbenchScreenshotDelivery>;
}

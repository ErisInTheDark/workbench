/*
 * Exports:
 * - WorkbenchScreenshotDelivery: acknowledged screenshot delivery through the provider's supported mechanism.
 * - WorkbenchProviderBrowse: durable Browse results and explicit screenshot delivery with WB references.
 */
import type { WorkbenchBrowseResultEntry } from "../../types.ts";

export type WorkbenchScreenshotDelivery =
  | { kind: "injected"; acceptedAt: number; turnId: string }
  | { kind: "steered"; turnId: string };

export interface WorkbenchProviderBrowse {
  record(entry: WorkbenchBrowseResultEntry): Promise<void>;
  screenshot(input: { threadId: string; turnId: string; imageUrl: string }): Promise<WorkbenchScreenshotDelivery>;
}

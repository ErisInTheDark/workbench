/*
 * Exports:
 * - OpenCodeTranscriptSource: provider-local structured transcript provenance.
 * - openCodeContentSource: identify one typed assistant content stream across live events and canonical rereads.
 * - openCodeItemSource: identify one whole OpenCode message or tool item.
 */
import type { WorkbenchTranscriptItemSource } from "../../database/transcript/workbench-transcript-types";

export type OpenCodeTranscriptSource = Pick<WorkbenchTranscriptItemSource, "component" | "reference">;

export function openCodeContentSource(
  assistantMessageId: string,
  kind: "reasoning" | "text",
  ordinal: number,
): OpenCodeTranscriptSource {
  return {
    reference: assistantMessageId,
    component: { kind, index: ordinal },
  };
}

export function openCodeItemSource(reference: string): OpenCodeTranscriptSource {
  return {
    reference,
    component: { kind: "item", index: 0 },
  };
}

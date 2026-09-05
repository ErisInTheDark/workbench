/*
 * Keywords: transcript, tool context, relational.
 * Exports:
 * - transformToolOutputTranscriptItem: store supported native output without opaque JSON.
 */
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import { deleteRows, insertRow, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { itemTables } from "../workbench-database-schema.ts";
import type { WorkbenchTranscriptItemTransform, WorkbenchTranscriptItemTransformContext } from "./workbench-transcript-transform-registry.ts";

export function transformToolOutputTranscriptItem({ item, itemId }: WorkbenchTranscriptItemTransformContext): WorkbenchTranscriptItemTransform | null {
  if (item.type !== "functionCallOutput") return null;
  const output = readWorkbenchToolOutput(item);
  if (!output) return null;
  return {
    itemType: "functionCallOutput",
    cleanup: [deleteRows(itemTables.threadToolOutputParts, { item_id: itemId })],
    mutations: [
      upsertRow(itemTables.threadItemToolOutputs, {
        item_id: itemId,
        name: output.name,
        namespace: output.namespace,
        body_kind: typeof output.output === "string" ? "text" : "parts",
        body_text: typeof output.output === "string" ? output.output : null,
        injection_accepted_at: output.workbenchInjectionAcceptedAt ?? null,
      }, {
        conflictColumns: ["item_id"],
        updateColumns: ["name", "namespace", "body_kind", "body_text", "injection_accepted_at"],
      }),
      ...(typeof output.output === "string" ? [] : output.output.map((part, partIndex) => insertRow(itemTables.threadToolOutputParts, {
        item_id: itemId,
        part_index: partIndex,
        part_type: part.type === "input_text" ? "text" : "image",
        text: part.type === "input_text" ? part.text : null,
        image_url: part.type === "input_image" ? part.image_url : null,
        image_detail: part.type === "input_image" ? part.detail ?? null : null,
      }))),
    ],
  };
}

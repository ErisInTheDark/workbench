/*
 * WorkbenchTranscriptItemTransformContext/WorkbenchTranscriptItemTransform: stable transform inputs and relational output. Keywords: transcript, transform, registry.
 * transformWorkbenchTranscriptItem: route one current renderer item through focused transform owners. Keywords: transcript, transform, item.
 */
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem.ts";
import type { WorkbenchFileChangeItem } from "../../../lib/workbench/thread/workbench-file-change.ts";
import type { ItemSchemaRows } from "../../../lib/workbench/database/schema/item-schema.ts";
import type { WorkbenchDatabaseMutation } from "workbench-shared/database/workbench-database-statements";
import { transformCoreTranscriptItem } from "./workbench-transcript-core-transformers.ts";
import { transformInteractionTranscriptItem } from "./workbench-transcript-interaction-transformers.ts";
import { transformOperationTranscriptItem } from "./workbench-transcript-operation-transformers.ts";
import type { WorkbenchTranscriptItemLifecycle } from "./workbench-transcript-types.ts";

export interface WorkbenchTranscriptItemTransformContext {
  item: ThreadItem | WorkbenchFileChangeItem;
  lifecycle: WorkbenchTranscriptItemLifecycle;
  sourceRevision: number;
}

export interface WorkbenchTranscriptItemTransform {
  itemType: ItemSchemaRows["threadItems"]["type"];
  cleanup: WorkbenchDatabaseMutation[];
  mutations: WorkbenchDatabaseMutation[];
}

export function transformWorkbenchTranscriptItem(
  context: WorkbenchTranscriptItemTransformContext,
): WorkbenchTranscriptItemTransform {
  return transformCoreTranscriptItem(context)
    ?? transformInteractionTranscriptItem(context)
    ?? transformOperationTranscriptItem(context);
}

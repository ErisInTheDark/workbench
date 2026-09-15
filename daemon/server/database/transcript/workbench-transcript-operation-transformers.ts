/*
 * transformOperationTranscriptItem: convert process, callable-tool, and collaboration source items to relational mutations. Keywords: transcript, transform, operation.
 */
import type { JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
import { operationSourceTables } from "../workbench-database-schema.ts";
import {
  deleteRows,
  insertRow,
  upsertRow,
  type WorkbenchDatabaseMutation,
} from "workbench-shared/database/workbench-database-statements";
import type {
  WorkbenchTranscriptItemTransform,
  WorkbenchTranscriptItemTransformContext,
} from "./workbench-transcript-transform-registry.ts";

function json(value: JsonValue | null) {
  return value === null ? null : JSON.stringify(value);
}

function record(value: JsonValue) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function sourceCleanup(itemId: number): WorkbenchDatabaseMutation[] {
  return [
    deleteRows(operationSourceTables.threadOperationProcessSources, { item_id: itemId }),
    deleteRows(operationSourceTables.threadOperationToolSources, { item_id: itemId }),
  ];
}

export function transformOperationTranscriptItem(
  { item, itemId, sourceRevision }: WorkbenchTranscriptItemTransformContext,
): WorkbenchTranscriptItemTransform {
  if (item.type === "commandExecution") {
    return {
      itemType: "operation",
      cleanup: sourceCleanup(itemId),
      mutations: [
        upsertRow(operationSourceTables.threadItemOperations, {
          item_id: itemId,
          source_kind: "process",
          source_revision: sourceRevision,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["source_kind", "source_revision"],
        }),
        insertRow(operationSourceTables.threadOperationProcessSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          state: item.status,
          command: item.command,
          cwd: item.cwd,
          process_id: item.processId,
          plugin_id: item.pluginId,
          script_path: item.scriptPath,
          output_text: item.aggregatedOutput,
          exit_code: item.exitCode,
          duration_ms: item.durationMs,
          error_text: null,
        }),
        ...item.commandActions.map((action, actionIndex) => insertRow(
          operationSourceTables.threadProcessCommandActions,
          {
            item_id: itemId,
            action_index: actionIndex,
            action_kind: action.type,
            command: action.command,
            name: action.type === "read" ? action.name : null,
            path: action.type === "read" || action.type === "listFiles" || action.type === "search"
              ? action.path
              : null,
            query: action.type === "search" ? action.query : null,
          },
        )),
      ],
    };
  }

  if (item.type === "mcpToolCall") {
    const resultMutations: WorkbenchDatabaseMutation[] = [];
    if (item.result) {
      resultMutations.push(insertRow(operationSourceTables.threadCallableMcpResults, {
        item_id: itemId,
        source_revision: sourceRevision,
        structured_content_json: json(item.result.structuredContent),
        meta_json: json(item.result._meta),
      }));
      for (const [contentIndex, content] of item.result.content.entries()) {
        const contentRecord = record(content);
        const text = contentRecord?.type === "text" && typeof contentRecord.text === "string"
          ? contentRecord.text
          : null;
        resultMutations.push(insertRow(operationSourceTables.threadCallableMcpResultContent, {
          item_id: itemId,
          source_revision: sourceRevision,
          content_index: contentIndex,
          content_kind: text === null ? "opaque" : "text",
          text,
          opaque_json: text === null ? JSON.stringify(content) : null,
        }));
      }
    }
    return {
      itemType: "operation",
      cleanup: sourceCleanup(itemId),
      mutations: [
        upsertRow(operationSourceTables.threadItemOperations, {
          item_id: itemId,
          source_kind: "tool",
          source_revision: sourceRevision,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["source_kind", "source_revision"],
        }),
        insertRow(operationSourceTables.threadOperationToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          tool_kind: "callable",
          state: item.status,
          tool_name: item.tool,
          duration_ms: item.durationMs,
        }),
        insertRow(operationSourceTables.threadOperationCallableToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          state: item.status,
          tool_name: item.tool,
          callable_kind: "mcp",
          namespace: null,
          server_name: item.server,
          arguments_json: JSON.stringify(item.arguments),
          app_connector_id: item.appContext?.connectorId ?? null,
          app_link_id: item.appContext?.linkId ?? null,
          app_resource_uri: item.appContext?.resourceUri ?? null,
          app_name: item.appContext?.appName ?? null,
          app_action_name: item.appContext?.actionName ?? null,
          legacy_resource_uri: item.mcpAppResourceUri ?? null,
          plugin_id: item.pluginId,
          read_only_hint: item.readOnlyHint === null ? null : item.readOnlyHint ? 1 : 0,
          success: null,
          error_text: item.error?.message ?? null,
        }),
        ...resultMutations,
      ],
    };
  }

  if (item.type === "dynamicToolCall") {
    return {
      itemType: "operation",
      cleanup: sourceCleanup(itemId),
      mutations: [
        upsertRow(operationSourceTables.threadItemOperations, {
          item_id: itemId,
          source_kind: "tool",
          source_revision: sourceRevision,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["source_kind", "source_revision"],
        }),
        insertRow(operationSourceTables.threadOperationToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          tool_kind: "callable",
          state: item.status,
          tool_name: item.tool,
          duration_ms: item.durationMs,
        }),
        insertRow(operationSourceTables.threadOperationCallableToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          state: item.status,
          tool_name: item.tool,
          callable_kind: "dynamic",
          namespace: item.namespace,
          server_name: null,
          arguments_json: JSON.stringify(item.arguments),
          success: item.success === null ? null : item.success ? 1 : 0,
          error_text: null,
        }),
        ...(item.contentItems ?? []).map((content, contentIndex) => insertRow(
          operationSourceTables.threadCallableDynamicContent,
          {
            item_id: itemId,
            source_revision: sourceRevision,
            content_index: contentIndex,
            content_kind: content.type,
            text: content.type === "inputText" ? content.text : null,
            url: content.type === "inputImage" ? content.imageUrl : content.type === "inputAudio" ? content.audioUrl : null,
          },
        )),
      ],
    };
  }

  if (item.type === "collabAgentToolCall") {
    return {
      itemType: "operation",
      cleanup: sourceCleanup(itemId),
      mutations: [
        upsertRow(operationSourceTables.threadItemOperations, {
          item_id: itemId,
          source_kind: "tool",
          source_revision: sourceRevision,
        }, {
          conflictColumns: ["item_id"],
          updateColumns: ["source_kind", "source_revision"],
        }),
        insertRow(operationSourceTables.threadOperationToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          tool_kind: "collaboration",
          state: item.status,
          tool_name: item.tool,
          duration_ms: null,
        }),
        insertRow(operationSourceTables.threadOperationCollaborationToolSources, {
          item_id: itemId,
          source_revision: sourceRevision,
          state: item.status,
          tool_name: item.tool,
          sender_thread_id: item.senderThreadId,
          prompt: item.prompt,
          model: item.model,
          reasoning_effort: item.reasoningEffort,
        }),
        ...item.receiverThreadIds.map((receiverThreadId, receiverIndex) => insertRow(
          operationSourceTables.threadCollaborationReceivers,
          {
            item_id: itemId,
            receiver_index: receiverIndex,
            receiver_thread_id: receiverThreadId,
          },
        )),
        ...Object.entries(item.agentsStates).flatMap(([agentThreadId, state]) => (
          state
            ? [insertRow(operationSourceTables.threadCollaborationAgentStates, {
              item_id: itemId,
              agent_thread_id: agentThreadId,
              status: state.status,
              message: state.message,
            })]
            : []
        )),
      ],
    };
  }

  throw new Error(`Unsupported operation transcript item: ${item.type}`);
}

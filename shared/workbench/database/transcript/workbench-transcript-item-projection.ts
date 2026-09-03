/*
 * WorkbenchProjectedInteractionItem/WorkbenchProjectedUnknownItem/WorkbenchProjectedTranscriptItem: canonical item values reconstructed from relational rows. Keywords: transcript, projection, item.
 * WorkbenchTranscriptItemProjectionRow/WorkbenchTranscriptItemProjectionResult: ordered relational item reconstruction or one bounded integrity failure. Keywords: transcript, projection, database, validation.
 * projectWorkbenchTranscriptItems: reconstruct canonical item payloads from one ordered relational row scope. Keywords: transcript, projection, item, database.
 */
import type { JsonValue } from "../../../codex/generated/app-server/serde_json/JsonValue.ts";
import type { ThreadItem } from "../../../codex/generated/app-server/v2/ThreadItem.ts";
import type {
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../../types.ts";
import type { WorkbenchFileChangeItem } from "../../thread/workbench-file-change.ts";
import type { WorkbenchTranscriptSnapshot } from "./workbench-transcript-contract.ts";

export interface WorkbenchProjectedInteractionItem {
  errorText: string | null;
  id: string;
  request: WorkbenchUserInputRequest;
  requestKey: string;
  resolvedAt: number;
  response: WorkbenchUserInputResponse;
  state: "answered" | "cancelled" | "failed";
  type: "approval" | "questionnaire";
}

export interface WorkbenchProjectedUnknownItem {
  id: string;
  nativeType: string;
  safeValue: JsonValue;
  type: "unknown";
}

export type WorkbenchProjectedTranscriptItem =
  | ThreadItem
  | WorkbenchFileChangeItem
  | WorkbenchProjectedInteractionItem
  | WorkbenchProjectedUnknownItem;

export interface WorkbenchTranscriptItemProjectionRow {
  item: WorkbenchProjectedTranscriptItem;
  root: WorkbenchTranscriptSnapshot["rows"]["threadItems"][number];
}

export interface WorkbenchTranscriptProjectionIssue {
  code:
    | "duplicateRow"
    | "invalidJson"
    | "invalidReference"
    | "invalidRow"
    | "missingRow"
    | "unexpectedRow";
  itemId?: string;
  table: string;
}

export type WorkbenchTranscriptItemProjectionResult =
  | { data: WorkbenchTranscriptItemProjectionRow[]; success: true }
  | { issues: WorkbenchTranscriptProjectionIssue[]; success: false };

class ProjectionFailure extends Error {
  readonly issue: WorkbenchTranscriptProjectionIssue;

  constructor(issue: WorkbenchTranscriptProjectionIssue) {
    super(`${issue.code} in ${issue.table}`);
    this.issue = issue;
  }
}

type Rows = WorkbenchTranscriptSnapshot["rows"];

function fail(
  code: WorkbenchTranscriptProjectionIssue["code"],
  table: string,
  itemId?: string,
): never {
  throw new ProjectionFailure({ code, table, ...(itemId ? { itemId: itemId.slice(0, 200) } : {}) });
}

function parseJson(value: string, table: string, itemId?: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return fail("invalidJson", table, itemId);
  }
}

function one<Row>(
  rows: readonly Row[],
  table: string,
  itemId: string,
): Row {
  if (rows.length === 0) return fail("missingRow", table, itemId);
  if (rows.length !== 1) return fail("duplicateRow", table, itemId);
  return rows[0]!;
}

function indexedRows<Row>(
  rows: readonly Row[],
  indexOf: (row: Row) => number,
  table: string,
  itemId: string,
) {
  const ordered = [...rows].sort((left, right) => indexOf(left) - indexOf(right));
  ordered.forEach((row, index) => {
    if (indexOf(row) !== index) fail("invalidRow", table, itemId);
  });
  return ordered;
}

function byItem<Row extends { item_id: number }>(
  rows: readonly Row[],
  sourceIdsByItemId: ReadonlyMap<number, string>,
) {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const sourceId = sourceIdsByItemId.get(row.item_id);
    if (!sourceId) fail("invalidReference", "itemAugmentation", String(row.item_id));
    const itemRows = result.get(sourceId) ?? [];
    itemRows.push(row);
    result.set(sourceId, itemRows);
  }
  return result;
}

function commandActions(
  rows: readonly Rows["threadProcessCommandActions"][number][],
  table: string,
  itemId: string,
): Extract<ThreadItem, { type: "commandExecution" }>["commandActions"] {
  return indexedRows(rows, ({ action_index }) => action_index, table, itemId).map((row) => {
    switch (row.action_kind) {
      case "read":
        if (row.name === null || row.path === null || row.query !== null) fail("invalidRow", table, itemId);
        return { command: row.command, name: row.name, path: row.path, type: "read" };
      case "listFiles":
        if (row.name !== null || row.query !== null) fail("invalidRow", table, itemId);
        return { command: row.command, path: row.path, type: "listFiles" };
      case "search":
        if (row.name !== null) fail("invalidRow", table, itemId);
        return { command: row.command, path: row.path, query: row.query, type: "search" };
      case "unknown":
        if (row.name !== null || row.path !== null || row.query !== null) fail("invalidRow", table, itemId);
        return { command: row.command, type: "unknown" };
    }
  });
}

function userMessage(
  itemId: string,
  indexes: ReturnType<typeof createIndexes>,
): Extract<ThreadItem, { type: "userMessage" }> {
  const owner = one(indexes.userMessages.get(itemId) ?? [], "threadItemUserMessages", itemId);
  const parts = indexedRows(
    indexes.userMessageParts.get(itemId) ?? [],
    ({ part_index }) => part_index,
    "threadUserMessageParts",
    itemId,
  ).map<Extract<ThreadItem, { type: "userMessage" }>["content"][number]>((part) => {
    switch (part.part_type) {
      case "text":
        if (part.text === null) return fail("invalidRow", "threadUserMessageParts", itemId);
        return { text: part.text, text_elements: [], type: "text" };
      case "image":
        if (part.url === null) return fail("invalidRow", "threadUserMessageParts", itemId);
        return { ...(part.image_detail ? { detail: part.image_detail } : {}), type: "image", url: part.url };
      case "localImage":
        if (part.path === null) return fail("invalidRow", "threadUserMessageParts", itemId);
        return { ...(part.image_detail ? { detail: part.image_detail } : {}), path: part.path, type: "localImage" };
      case "skill":
      case "mention":
        if (part.path === null || part.name === null) return fail("invalidRow", "threadUserMessageParts", itemId);
        return { name: part.name, path: part.path, type: part.part_type };
    }
  });
  return { clientId: owner.client_id, content: parts, id: itemId, type: "userMessage" };
}

function processOperation(
  itemId: string,
  indexes: ReturnType<typeof createIndexes>,
): Extract<ThreadItem, { type: "commandExecution" }> {
  const source = one(indexes.processSources.get(itemId) ?? [], "threadOperationProcessSources", itemId);
  const status = source.state === "queued"
    ? "inProgress"
    : source.state === "timedOut"
      ? "failed"
      : source.state;
  return {
    aggregatedOutput: source.output_text,
    command: source.command,
    commandActions: commandActions(indexes.processActions.get(itemId) ?? [], "threadProcessCommandActions", itemId),
    cwd: source.cwd,
    durationMs: source.duration_ms,
    exitCode: source.exit_code,
    id: itemId,
    pluginId: source.plugin_id,
    processId: source.process_id,
    scriptPath: source.script_path,
    source: "agent",
    status,
    type: "commandExecution",
  };
}

function callableOperation(
  itemId: string,
  indexes: ReturnType<typeof createIndexes>,
): Extract<ThreadItem, { type: "mcpToolCall" | "dynamicToolCall" }> {
  const source = one(
    indexes.callableSources.get(itemId) ?? [],
    "threadOperationCallableToolSources",
    itemId,
  );
  const tool = one(
    indexes.toolSources.get(itemId) ?? [],
    "threadOperationToolSources",
    itemId,
  );
  const argumentsValue = parseJson(source.arguments_json, "threadOperationCallableToolSources", itemId);
  if (source.callable_kind === "dynamic") {
    const contentItems = indexedRows(
      indexes.dynamicContent.get(itemId) ?? [],
      ({ content_index }) => content_index,
      "threadCallableDynamicContent",
      itemId,
    ).map<NonNullable<Extract<ThreadItem, { type: "dynamicToolCall" }>["contentItems"]>[number]>((content) => {
      if (content.content_kind === "inputText") {
        if (content.text === null) return fail("invalidRow", "threadCallableDynamicContent", itemId);
        return { text: content.text, type: "inputText" };
      }
      if (content.url === null) return fail("invalidRow", "threadCallableDynamicContent", itemId);
      return content.content_kind === "inputImage"
        ? { imageUrl: content.url, type: "inputImage" }
        : { audioUrl: content.url, type: "inputAudio" };
    });
    return {
      arguments: argumentsValue,
      contentItems: contentItems.length ? contentItems : null,
      durationMs: tool.duration_ms,
      id: itemId,
      namespace: source.namespace,
      status: tool.state,
      success: source.success === null ? null : source.success === 1,
      tool: tool.tool_name,
      type: "dynamicToolCall",
    };
  }

  if (source.server_name === null) fail("invalidRow", "threadOperationCallableToolSources", itemId);
  const resultRows = indexes.mcpResults.get(itemId) ?? [];
  const result = resultRows.length
    ? (() => {
      const owner = one(resultRows, "threadCallableMcpResults", itemId);
      const content = indexedRows(
        (indexes.mcpContent.get(itemId) ?? []).filter(({ source_revision }) => source_revision === owner.source_revision),
        ({ content_index }) => content_index,
        "threadCallableMcpResultContent",
        itemId,
      ).map((entry) => entry.content_kind === "text"
        ? { text: entry.text!, type: "text" }
        : parseJson(entry.opaque_json!, "threadCallableMcpResultContent", itemId));
      return {
        _meta: owner.meta_json === null ? null : parseJson(owner.meta_json, "threadCallableMcpResults", itemId),
        content,
        structuredContent: owner.structured_content_json === null
          ? null
          : parseJson(owner.structured_content_json, "threadCallableMcpResults", itemId),
      };
    })()
    : null;
  const appContext = source.app_connector_id === null
    ? null
    : {
      actionName: source.app_action_name,
      appName: source.app_name,
      connectorId: source.app_connector_id,
      linkId: source.app_link_id,
      resourceUri: source.app_resource_uri,
    };
  return {
    appContext,
    arguments: argumentsValue,
    durationMs: tool.duration_ms,
    error: source.error_text === null ? null : { message: source.error_text },
    id: itemId,
    ...(source.legacy_resource_uri === null ? {} : { mcpAppResourceUri: source.legacy_resource_uri }),
    pluginId: source.plugin_id,
    readOnlyHint: source.read_only_hint === null ? null : source.read_only_hint === 1,
    result,
    server: source.server_name,
    status: tool.state,
    tool: tool.tool_name,
    type: "mcpToolCall",
  };
}

function collaborationOperation(
  itemId: string,
  indexes: ReturnType<typeof createIndexes>,
): Extract<ThreadItem, { type: "collabAgentToolCall" }> {
  const source = one(
    indexes.collaborationSources.get(itemId) ?? [],
    "threadOperationCollaborationToolSources",
    itemId,
  );
  const receivers = indexedRows(
    indexes.collaborationReceivers.get(itemId) ?? [],
    ({ receiver_index }) => receiver_index,
    "threadCollaborationReceivers",
    itemId,
  );
  return {
    agentsStates: Object.fromEntries((indexes.collaborationStates.get(itemId) ?? []).map((state) => [
      state.agent_thread_id,
      { message: state.message, status: state.status },
    ])),
    id: itemId,
    model: source.model,
    prompt: source.prompt,
    reasoningEffort: source.reasoning_effort,
    receiverThreadIds: receivers.map(({ receiver_thread_id }) => receiver_thread_id),
    senderThreadId: source.sender_thread_id,
    status: source.state,
    tool: source.tool_name,
    type: "collabAgentToolCall",
  };
}

function interactionItem(
  itemId: string,
  type: "approval" | "questionnaire",
  indexes: ReturnType<typeof createIndexes>,
): WorkbenchProjectedInteractionItem {
  const owner = one(indexes.interactions.get(itemId) ?? [], "threadItemInteractions", itemId);
  if (owner.item_type !== type) fail("invalidRow", "threadItemInteractions", itemId);
  const questions = indexedRows(
    indexes.interactionQuestions.get(itemId) ?? [],
    ({ question_index }) => question_index,
    "threadInteractionQuestions",
    itemId,
  ).map((question) => ({
    allowOther: question.allow_other === 1,
    header: question.header,
    id: question.question_id,
    isSecret: question.is_secret === 1,
    options: indexedRows(
      (indexes.interactionOptions.get(itemId) ?? []).filter(({ question_index }) => question_index === question.question_index),
      ({ option_index }) => option_index,
      "threadInteractionOptions",
      itemId,
    ).map(({ description, label }) => ({ description, label })),
    question: question.question,
  }));
  const answers: WorkbenchUserInputResponse["answers"] = {};
  for (const question of questions) {
    answers[question.id] = {
      answers: indexedRows(
        (indexes.interactionAnswers.get(itemId) ?? []).filter(({ question_id }) => question_id === question.id),
        ({ answer_index }) => answer_index,
        "threadInteractionAnswers",
        itemId,
      ).map(({ answer }) => answer),
    };
  }
  const approvalContext = indexes.approvalContexts.get(itemId) ?? [];
  const approval = type === "approval"
    ? (() => {
      const command = one(approvalContext, "threadApprovalCommandContexts", itemId);
      return {
        command: {
          command: command.command,
          commandActions: commandActions(
            indexes.approvalActions.get(itemId) ?? [],
            "threadApprovalCommandActions",
            itemId,
          ),
          cwd: command.cwd,
        },
      };
    })()
    : undefined;
  if (type === "questionnaire" && approvalContext.length) fail("unexpectedRow", "threadApprovalCommandContexts", itemId);
  return {
    errorText: owner.error_text,
    id: itemId,
    request: {
      ...(approval ? { approval } : {}),
      id: owner.request_id,
      questions,
      submitLabel: owner.submit_label,
      summary: owner.summary,
      title: owner.title,
    },
    requestKey: owner.request_key,
    resolvedAt: owner.resolved_at,
    response: { answers },
    state: owner.state,
    type,
  };
}

function projectItem(
  root: Rows["threadItems"][number],
  indexes: ReturnType<typeof createIndexes>,
): WorkbenchProjectedTranscriptItem {
  const itemId = root.source_id;
  switch (root.type) {
    case "userMessage":
      return userMessage(itemId, indexes);
    case "assistantMessage": {
      const item = one(indexes.assistantMessages.get(itemId) ?? [], "threadItemAssistantMessages", itemId);
      return {
        id: itemId,
        memoryCitation: null,
        phase: item.phase === "finalAnswer" ? "final_answer" : item.phase === "commentary" ? "commentary" : null,
        text: item.text,
        type: "agentMessage",
      };
    }
    case "plan": {
      const item = one(indexes.plans.get(itemId) ?? [], "threadItemPlans", itemId);
      return { id: itemId, text: item.text, type: "plan" };
    }
    case "reasoning": {
      one(indexes.reasoning.get(itemId) ?? [], "threadItemReasoning", itemId);
      const sections = indexedRows(
        indexes.reasoningSections.get(itemId) ?? [],
        ({ section_index }) => section_index,
        "threadReasoningSections",
        itemId,
      ).map(({ text }) => text);
      return { content: [], id: itemId, summary: sections, type: "reasoning" };
    }
    case "operation": {
      const owner = one(indexes.operations.get(itemId) ?? [], "threadItemOperations", itemId);
      if (owner.source_kind === "process") return processOperation(itemId, indexes);
      const tool = one(indexes.toolSources.get(itemId) ?? [], "threadOperationToolSources", itemId);
      return tool.tool_kind === "callable"
        ? callableOperation(itemId, indexes)
        : collaborationOperation(itemId, indexes);
    }
    case "fileChange": {
      const owner = one(indexes.fileChangeItems.get(itemId) ?? [], "threadItemFileChanges", itemId);
      return {
        changes: indexedRows(
          indexes.fileChanges.get(itemId) ?? [],
          ({ change_index }) => change_index,
          "threadFileChanges",
          itemId,
        ).map((change) => ({
          diff: change.diff,
          kind: change.change_kind === "update"
            ? { move_path: change.move_path, type: "update" as const }
            : { type: change.change_kind },
          path: change.path,
          ...(change.workbench_additions === null ? {} : { workbenchAdditions: change.workbench_additions }),
          ...(change.workbench_deletions === null ? {} : { workbenchDeletions: change.workbench_deletions }),
        })),
        id: itemId,
        status: owner.state,
        type: "fileChange",
        ...(owner.workbench_failure_kind ? { workbenchFailureKind: owner.workbench_failure_kind } : {}),
      };
    }
    case "webSearch": {
      const owner = one(indexes.webSearchItems.get(itemId) ?? [], "threadItemWebSearches", itemId);
      const queries = indexedRows(
        indexes.webSearchQueries.get(itemId) ?? [],
        ({ query_index }) => query_index,
        "threadWebSearchQueries",
        itemId,
      ).map(({ query }) => query);
      const action = owner.action_kind === "none"
        ? null
        : owner.action_kind === "search"
          ? { queries, query: owner.action_query, type: "search" as const }
          : owner.action_kind === "openPage"
            ? { type: "openPage" as const, url: owner.url }
            : owner.action_kind === "findInPage"
              ? { pattern: owner.pattern, type: "findInPage" as const, url: owner.url }
              : { type: "other" as const };
      const results = indexedRows(
        indexes.webSearchResults.get(itemId) ?? [],
        ({ result_index }) => result_index,
        "threadWebSearchResults",
        itemId,
      ).map(({ opaque_json }) => parseJson(opaque_json, "threadWebSearchResults", itemId));
      return { action, id: itemId, query: owner.query, results: results.length ? results : null, type: "webSearch" };
    }
    case "questionnaire":
    case "approval":
      return interactionItem(itemId, root.type, indexes);
    case "contextCompaction":
      one(indexes.contextCompactions.get(itemId) ?? [], "threadItemContextCompactions", itemId);
      return { id: itemId, type: "contextCompaction" };
    case "unknown": {
      const item = one(indexes.unknownItems.get(itemId) ?? [], "threadItemUnknown", itemId);
      return {
        id: itemId,
        nativeType: item.native_type,
        safeValue: parseJson(item.safe_json, "threadItemUnknown", itemId),
        type: "unknown",
      };
    }
  }
}

function createIndexes(rows: Rows, sourceIdsByItemId: ReadonlyMap<number, string>) {
  return {
    approvalActions: byItem(rows.threadApprovalCommandActions, sourceIdsByItemId),
    approvalContexts: byItem(rows.threadApprovalCommandContexts, sourceIdsByItemId),
    assistantMessages: byItem(rows.threadItemAssistantMessages, sourceIdsByItemId),
    callableSources: byItem(rows.threadOperationCallableToolSources, sourceIdsByItemId),
    collaborationReceivers: byItem(rows.threadCollaborationReceivers, sourceIdsByItemId),
    collaborationSources: byItem(rows.threadOperationCollaborationToolSources, sourceIdsByItemId),
    collaborationStates: byItem(rows.threadCollaborationAgentStates, sourceIdsByItemId),
    contextCompactions: byItem(rows.threadItemContextCompactions, sourceIdsByItemId),
    dynamicContent: byItem(rows.threadCallableDynamicContent, sourceIdsByItemId),
    fileChangeItems: byItem(rows.threadItemFileChanges, sourceIdsByItemId),
    fileChanges: byItem(rows.threadFileChanges, sourceIdsByItemId),
    interactionAnswers: byItem(rows.threadInteractionAnswers, sourceIdsByItemId),
    interactions: byItem(rows.threadItemInteractions, sourceIdsByItemId),
    interactionOptions: byItem(rows.threadInteractionOptions, sourceIdsByItemId),
    interactionQuestions: byItem(rows.threadInteractionQuestions, sourceIdsByItemId),
    mcpContent: byItem(rows.threadCallableMcpResultContent, sourceIdsByItemId),
    mcpResults: byItem(rows.threadCallableMcpResults, sourceIdsByItemId),
    operations: byItem(rows.threadItemOperations, sourceIdsByItemId),
    plans: byItem(rows.threadItemPlans, sourceIdsByItemId),
    processActions: byItem(rows.threadProcessCommandActions, sourceIdsByItemId),
    processSources: byItem(rows.threadOperationProcessSources, sourceIdsByItemId),
    reasoning: byItem(rows.threadItemReasoning, sourceIdsByItemId),
    reasoningSections: byItem(rows.threadReasoningSections, sourceIdsByItemId),
    toolSources: byItem(rows.threadOperationToolSources, sourceIdsByItemId),
    unknownItems: byItem(rows.threadItemUnknown, sourceIdsByItemId),
    userMessages: byItem(rows.threadItemUserMessages, sourceIdsByItemId),
    userMessageParts: byItem(rows.threadUserMessageParts, sourceIdsByItemId),
    webSearchItems: byItem(rows.threadItemWebSearches, sourceIdsByItemId),
    webSearchQueries: byItem(rows.threadWebSearchQueries, sourceIdsByItemId),
    webSearchResults: byItem(rows.threadWebSearchResults, sourceIdsByItemId),
  };
}

export function projectWorkbenchTranscriptItems(
  rows: WorkbenchTranscriptSnapshot["rows"],
): WorkbenchTranscriptItemProjectionResult {
  try {
    const itemRootsById = new Map(rows.threadItems.map((item) => [item.id, item]));
    if (itemRootsById.size !== rows.threadItems.length) fail("duplicateRow", "threadItems");
    const sourceIdsByItemId = new Map(rows.threadItems.map((item) => [item.id, item.source_id]));
    const itemRootsBySourceId = new Map(rows.threadItems.map((item) => [item.source_id, item]));
    if (itemRootsBySourceId.size !== rows.threadItems.length) fail("duplicateRow", "threadItems");
    const indexes = createIndexes(rows, sourceIdsByItemId);
    return {
      data: rows.threadItems.map((root) => ({
        item: projectItem(root, indexes),
        root,
      })),
      success: true,
    };
  } catch (error) {
    if (error instanceof ProjectionFailure) return { issues: [error.issue], success: false };
    throw error;
  }
}

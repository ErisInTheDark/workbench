/*
 * WorkbenchProjectedTranscriptItem/WorkbenchProjectedTranscriptTurn: browser-owned canonical transcript values reconstructed from relational rows. Keywords: transcript, projection, item, turn.
 * WorkbenchTranscriptProjection/WorkbenchTranscriptProjectionIssue: complete hydration-bounded projection or one bounded relational-integrity failure. Keywords: transcript, projection, validation.
 * projectWorkbenchTranscript: reconstruct renderer facts, interaction values, Browse facts, item timing, and canonical display segments without trusting opaque JSON as a ThreadItem. Keywords: transcript, browser, canonical, parity.
 */
import type { JsonValue } from "../../codex/generated/app-server/serde_json/JsonValue";
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../codex/generated/app-server/v2/Turn";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchThreadTurnHistoryEntry,
  WorkbenchUserInputRequest,
  WorkbenchUserInputResponse,
} from "../../types";
import type { WorkbenchFileChangeItem } from "../thread/workbench-file-change";
import type { WorkbenchThreadItemTimelineEntry } from "../thread/thread-item-timeline";
import type { WorkbenchTranscriptSnapshot } from "../database/transcript/workbench-transcript-contract";
import {
  planCanonicalTranscriptDisplay,
  type CanonicalTranscriptDisplayPlan,
} from "./thread-transcript-display-planner";

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

export interface WorkbenchProjectedTranscriptTurn extends Omit<Turn, "items"> {
  itemTimeline: WorkbenchThreadItemTimelineEntry[];
  items: WorkbenchProjectedTranscriptItem[];
  turnIndex: number;
}

export interface WorkbenchTranscriptProjection {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  display: CanonicalTranscriptDisplayPlan<WorkbenchProjectedTranscriptItem>;
  hasPreviousTurns: boolean;
  thread: {
    activityAt: number;
    createdAt: number;
    id: string;
    projectId: string;
    projectRoot: string;
    title: string;
    updatedAt: number;
  };
  turnHistory: WorkbenchThreadTurnHistoryEntry[];
  turns: WorkbenchProjectedTranscriptTurn[];
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

export type WorkbenchTranscriptProjectionResult =
  | { data: WorkbenchTranscriptProjection; success: true }
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

function byItem<Row extends { item_id: string }>(rows: readonly Row[]) {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const itemRows = result.get(row.item_id) ?? [];
    itemRows.push(row);
    result.set(row.item_id, itemRows);
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
  rows: Rows,
  partsByItem: ReadonlyMap<string, Rows["threadUserMessageParts"]>,
): Extract<ThreadItem, { type: "userMessage" }> {
  const owner = one(rows.threadItemUserMessages.filter(({ item_id }) => item_id === itemId), "threadItemUserMessages", itemId);
  const parts = indexedRows(
    partsByItem.get(itemId) ?? [],
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
  rows: Rows,
  processActionsByItem: ReadonlyMap<string, Rows["threadProcessCommandActions"]>,
): Extract<ThreadItem, { type: "commandExecution" }> {
  const source = one(rows.threadOperationProcessSources.filter(({ item_id }) => item_id === itemId), "threadOperationProcessSources", itemId);
  const status = source.state === "queued"
    ? "inProgress"
    : source.state === "timedOut"
      ? "failed"
      : source.state;
  return {
    aggregatedOutput: source.output_text,
    command: source.command,
    commandActions: commandActions(processActionsByItem.get(itemId) ?? [], "threadProcessCommandActions", itemId),
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
  rows: Rows,
  dynamicContentByItem: ReadonlyMap<string, Rows["threadCallableDynamicContent"]>,
  mcpContentByItem: ReadonlyMap<string, Rows["threadCallableMcpResultContent"]>,
): Extract<ThreadItem, { type: "mcpToolCall" | "dynamicToolCall" }> {
  const source = one(
    rows.threadOperationCallableToolSources.filter(({ item_id }) => item_id === itemId),
    "threadOperationCallableToolSources",
    itemId,
  );
  const tool = one(
    rows.threadOperationToolSources.filter(({ item_id }) => item_id === itemId),
    "threadOperationToolSources",
    itemId,
  );
  const argumentsValue = parseJson(source.arguments_json, "threadOperationCallableToolSources", itemId);
  if (source.callable_kind === "dynamic") {
    const contentItems = indexedRows(
      dynamicContentByItem.get(itemId) ?? [],
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
  const resultRows = rows.threadCallableMcpResults.filter(({ item_id }) => item_id === itemId);
  const result = resultRows.length
    ? (() => {
      const owner = one(resultRows, "threadCallableMcpResults", itemId);
      const content = indexedRows(
        (mcpContentByItem.get(itemId) ?? []).filter(({ source_revision }) => source_revision === owner.source_revision),
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
  rows: Rows,
  receiversByItem: ReadonlyMap<string, Rows["threadCollaborationReceivers"]>,
  agentStatesByItem: ReadonlyMap<string, Rows["threadCollaborationAgentStates"]>,
): Extract<ThreadItem, { type: "collabAgentToolCall" }> {
  const source = one(
    rows.threadOperationCollaborationToolSources.filter(({ item_id }) => item_id === itemId),
    "threadOperationCollaborationToolSources",
    itemId,
  );
  const receivers = indexedRows(
    receiversByItem.get(itemId) ?? [],
    ({ receiver_index }) => receiver_index,
    "threadCollaborationReceivers",
    itemId,
  );
  return {
    agentsStates: Object.fromEntries((agentStatesByItem.get(itemId) ?? []).map((state) => [
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
  rows: Rows,
  questionsByItem: ReadonlyMap<string, Rows["threadInteractionQuestions"]>,
  optionsByItem: ReadonlyMap<string, Rows["threadInteractionOptions"]>,
  answersByItem: ReadonlyMap<string, Rows["threadInteractionAnswers"]>,
  approvalActionsByItem: ReadonlyMap<string, Rows["threadApprovalCommandActions"]>,
): WorkbenchProjectedInteractionItem {
  const owner = one(rows.threadItemInteractions.filter(({ item_id }) => item_id === itemId), "threadItemInteractions", itemId);
  if (owner.item_type !== type) fail("invalidRow", "threadItemInteractions", itemId);
  const questions = indexedRows(
    questionsByItem.get(itemId) ?? [],
    ({ question_index }) => question_index,
    "threadInteractionQuestions",
    itemId,
  ).map((question) => ({
    allowOther: question.allow_other === 1,
    header: question.header,
    id: question.question_id,
    isSecret: question.is_secret === 1,
    options: indexedRows(
      (optionsByItem.get(itemId) ?? []).filter(({ question_index }) => question_index === question.question_index),
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
        (answersByItem.get(itemId) ?? []).filter(({ question_id }) => question_id === question.id),
        ({ answer_index }) => answer_index,
        "threadInteractionAnswers",
        itemId,
      ).map(({ answer }) => answer),
    };
  }
  const approvalContext = rows.threadApprovalCommandContexts.filter(({ item_id }) => item_id === itemId);
  const approval = type === "approval"
    ? (() => {
      const command = one(approvalContext, "threadApprovalCommandContexts", itemId);
      return {
        command: {
          command: command.command,
          commandActions: commandActions(
            approvalActionsByItem.get(itemId) ?? [],
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
  rows: Rows,
  indexes: ReturnType<typeof createIndexes>,
): WorkbenchProjectedTranscriptItem {
  const itemId = root.id;
  switch (root.type) {
    case "userMessage":
      return userMessage(itemId, rows, indexes.userMessageParts);
    case "assistantMessage": {
      const item = one(rows.threadItemAssistantMessages.filter(({ item_id }) => item_id === itemId), "threadItemAssistantMessages", itemId);
      return {
        id: itemId,
        memoryCitation: null,
        phase: item.phase === "finalAnswer" ? "final_answer" : item.phase === "commentary" ? "commentary" : null,
        text: item.text,
        type: "agentMessage",
      };
    }
    case "plan": {
      const item = one(rows.threadItemPlans.filter(({ item_id }) => item_id === itemId), "threadItemPlans", itemId);
      return { id: itemId, text: item.text, type: "plan" };
    }
    case "reasoning": {
      one(rows.threadItemReasoning.filter(({ item_id }) => item_id === itemId), "threadItemReasoning", itemId);
      const sections = indexedRows(
        indexes.reasoningSections.get(itemId) ?? [],
        ({ section_index }) => section_index,
        "threadReasoningSections",
        itemId,
      ).map(({ text }) => text);
      return { content: [], id: itemId, summary: sections, type: "reasoning" };
    }
    case "operation": {
      const owner = one(rows.threadItemOperations.filter(({ item_id }) => item_id === itemId), "threadItemOperations", itemId);
      if (owner.source_kind === "process") return processOperation(itemId, rows, indexes.processActions);
      const tool = one(rows.threadOperationToolSources.filter(({ item_id }) => item_id === itemId), "threadOperationToolSources", itemId);
      return tool.tool_kind === "callable"
        ? callableOperation(itemId, rows, indexes.dynamicContent, indexes.mcpContent)
        : collaborationOperation(itemId, rows, indexes.collaborationReceivers, indexes.collaborationStates);
    }
    case "fileChange": {
      const owner = one(rows.threadItemFileChanges.filter(({ item_id }) => item_id === itemId), "threadItemFileChanges", itemId);
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
      const owner = one(rows.threadItemWebSearches.filter(({ item_id }) => item_id === itemId), "threadItemWebSearches", itemId);
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
      return interactionItem(
        itemId,
        root.type,
        rows,
        indexes.interactionQuestions,
        indexes.interactionOptions,
        indexes.interactionAnswers,
        indexes.approvalActions,
      );
    case "contextCompaction":
      one(rows.threadItemContextCompactions.filter(({ item_id }) => item_id === itemId), "threadItemContextCompactions", itemId);
      return { id: itemId, type: "contextCompaction" };
    case "unknown": {
      const item = one(rows.threadItemUnknown.filter(({ item_id }) => item_id === itemId), "threadItemUnknown", itemId);
      return {
        id: itemId,
        nativeType: item.native_type,
        safeValue: parseJson(item.safe_json, "threadItemUnknown", itemId),
        type: "unknown",
      };
    }
  }
}

function createIndexes(rows: Rows) {
  return {
    approvalActions: byItem(rows.threadApprovalCommandActions),
    collaborationReceivers: byItem(rows.threadCollaborationReceivers),
    collaborationStates: byItem(rows.threadCollaborationAgentStates),
    dynamicContent: byItem(rows.threadCallableDynamicContent),
    fileChanges: byItem(rows.threadFileChanges),
    interactionAnswers: byItem(rows.threadInteractionAnswers),
    interactionOptions: byItem(rows.threadInteractionOptions),
    interactionQuestions: byItem(rows.threadInteractionQuestions),
    mcpContent: byItem(rows.threadCallableMcpResultContent),
    processActions: byItem(rows.threadProcessCommandActions),
    reasoningSections: byItem(rows.threadReasoningSections),
    userMessageParts: byItem(rows.threadUserMessageParts),
    webSearchQueries: byItem(rows.threadWebSearchQueries),
    webSearchResults: byItem(rows.threadWebSearchResults),
  };
}

function turnStatus(state: WorkbenchTranscriptSnapshot["turns"][number]["state"]): Turn["status"] {
  return state === "admitted" ? "inProgress" : state;
}

function seconds(value: number | null) {
  return value === null ? null : value / 1_000;
}

function browseEntries(
  snapshot: WorkbenchTranscriptSnapshot,
  itemRootsById: ReadonlyMap<string, Rows["threadItems"][number]>,
): WorkbenchBrowseResultEntry[] {
  const assetsByDigest = new Map(snapshot.rows.transcriptAssets.map((asset) => [asset.digest, asset]));
  if (assetsByDigest.size !== snapshot.rows.transcriptAssets.length) {
    return fail("duplicateRow", "transcriptAssets");
  }
  return [...snapshot.rows.threadBrowseEntries]
    .sort((left, right) => left.recorded_at - right.recorded_at || left.action_index - right.action_index)
    .map((entry) => {
      const root = itemRootsById.get(entry.item_id);
      if (!root) return fail("invalidReference", "threadBrowseEntries", entry.item_id);
      const asset = entry.asset_digest ? assetsByDigest.get(entry.asset_digest) : null;
      if (entry.asset_digest && !asset) {
        return fail("invalidReference", "threadBrowseEntries", entry.entry_key);
      }
      return {
        action: entry.action,
        actionIndex: entry.action_index,
        assetUrl: asset?.storage_key ?? null,
        commandItemId: entry.item_id,
        detailKind: entry.detail_kind,
        detailLabel: entry.detail_label,
        detailText: entry.detail_text,
        durationMs: entry.duration_ms,
        entryKey: entry.entry_key,
        recordedAt: entry.recorded_at,
        session: entry.session_name,
        state: entry.state,
        threadId: snapshot.thread.id,
        turnId: root.turn_id,
      };
    });
}

export function projectWorkbenchTranscript(
  snapshot: WorkbenchTranscriptSnapshot,
): WorkbenchTranscriptProjectionResult {
  try {
    const loadedTurnIds = new Set(snapshot.loadedTurnIds);
    if (loadedTurnIds.size !== snapshot.loadedTurnIds.length) fail("duplicateRow", "loadedTurnIds");
    const turnsById = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
    if (turnsById.size !== snapshot.turns.length) fail("duplicateRow", "turns");
    for (const turnId of loadedTurnIds) if (!turnsById.has(turnId)) fail("invalidReference", "loadedTurnIds", turnId);

    const itemRootsById = new Map(snapshot.rows.threadItems.map((item) => [item.id, item]));
    if (itemRootsById.size !== snapshot.rows.threadItems.length) fail("duplicateRow", "threadItems");
    const indexes = createIndexes(snapshot.rows);
    const projectedItems = snapshot.rows.threadItems
      .map((root) => ({ payload: projectItem(root, snapshot.rows, indexes), root }))
      .sort((left, right) => left.root.item_index - right.root.item_index);
    for (const { root } of projectedItems) {
      if (!loadedTurnIds.has(root.turn_id)) fail("invalidReference", "threadItems", root.id);
      if (root.thread_id !== snapshot.thread.id) fail("invalidReference", "threadItems", root.id);
    }
    const projectedItemsByTurn = new Map<string, WorkbenchProjectedTranscriptItem[]>();
    for (const { payload, root } of projectedItems) {
      const turnItems = projectedItemsByTurn.get(root.turn_id) ?? [];
      turnItems.push(payload);
      projectedItemsByTurn.set(root.turn_id, turnItems);
    }

    const timelinesByItemId = new Map(snapshot.rows.threadItemTimelines.map((entry) => [entry.item_id, entry]));
    const aliasesByItemId = new Map<string, string[]>();
    for (const entry of snapshot.rows.threadItemTimelineAliases) {
      const aliases = aliasesByItemId.get(entry.item_id) ?? [];
      aliases.push(entry.alias);
      aliasesByItemId.set(entry.item_id, aliases);
    }
    const orderedTurns = [...snapshot.turns].sort((left, right) => left.turn_index - right.turn_index);
    const projectedTurns: WorkbenchProjectedTranscriptTurn[] = orderedTurns
      .filter(({ id }) => loadedTurnIds.has(id))
      .map((turn) => {
        if (turn.thread_id !== snapshot.thread.id) fail("invalidReference", "turns", turn.id);
        const items = projectedItemsByTurn.get(turn.id) ?? [];
        const itemTimeline = items.flatMap<WorkbenchThreadItemTimelineEntry>((item) => {
          const timeline = timelinesByItemId.get(item.id);
          if (!timeline) return [];
          const aliases = aliasesByItemId.get(item.id) ?? [];
          return [{
            ...(aliases.length ? { aliases } : {}),
            completedAt: timeline.completed_at,
            firstSeenAt: timeline.first_seen_at,
            itemId: item.id,
            lastSeenAt: timeline.last_seen_at,
            startedAt: timeline.started_at,
          }];
        });
        return {
          completedAt: seconds(turn.ended_at),
          durationMs: turn.duration_ms,
          error: null,
          id: turn.id,
          items,
          itemsView: "full",
          itemTimeline,
          startedAt: seconds(turn.started_at),
          status: turnStatus(turn.state),
          turnIndex: turn.turn_index,
        };
      });
    const projectedTurnById = new Map(projectedTurns.map((turn) => [turn.id, turn]));
    const turnHistory = orderedTurns.map<WorkbenchThreadTurnHistoryEntry>((turn) => {
      const projected = projectedTurnById.get(turn.id);
      return {
        completedAt: seconds(turn.ended_at),
        durationMs: turn.duration_ms,
        itemCount: projected?.items.length ?? 0,
        ...(projected ? {
          itemIds: projected.items.map(({ id }) => id),
          itemTimeline: projected.itemTimeline,
        } : {}),
        loadState: projected ? "loaded" : "unloaded",
        startedAt: seconds(turn.started_at),
        status: turnStatus(turn.state),
        turnId: turn.id,
      };
    });
    const display = planCanonicalTranscriptDisplay({
      items: projectedItems.map(({ payload, root }) => ({
        itemId: root.id,
        itemIndex: root.item_index,
        payload,
        turnId: root.turn_id,
      })),
      turns: orderedTurns
        .filter(({ id }) => loadedTurnIds.has(id))
        .map(({ id, turn_index }) => ({ turnId: id, turnIndex: turn_index })),
    });

    return {
      data: {
        browseResultEntries: browseEntries(snapshot, itemRootsById),
        display,
        hasPreviousTurns: snapshot.hasPreviousTurns,
        thread: {
          activityAt: snapshot.thread.activity_at,
          createdAt: snapshot.thread.created_at,
          id: snapshot.thread.id,
          projectId: snapshot.thread.project_id,
          projectRoot: snapshot.thread.project_root,
          title: snapshot.thread.title,
          updatedAt: snapshot.thread.updated_at,
        },
        turnHistory,
        turns: projectedTurns,
      },
      success: true,
    };
  } catch (error) {
    if (error instanceof ProjectionFailure) return { issues: [error.issue], success: false };
    throw error;
  }
}

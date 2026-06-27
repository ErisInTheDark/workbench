/*
 * Exports:
 * - OPENCODE_INITIALIZE_RESULT/EMPTY_OPENCODE_RATE_LIMITS: bridge constants for OpenCode harness responses. Keywords: opencode, initialize, rate limits.
 * - OpenCodeMessageEntry/OpenCodeThreadSnapshotInput: typed OpenCode session/message bundle for thread conversion. Keywords: opencode, session, message, parts.
 * - cloneThread/formatPromptFromInput: helpers shared by the OpenCode bridge for thread snapshots and prompt payloads. Keywords: opencode, clone, prompt.
 * - opencodeSessionToThread/mapOpenCodeModelsToWorkbenchOptions/createOpenCodePermissionRequest/createOpenCodeQuestionRequest: convert typed OpenCode SDK data into Workbench/Codex-shaped state. Keywords: opencode, adapter, thread, models, permission, question.
 */
import type {
  Message,
  ModelV2Info,
  Part,
  PermissionV2Request,
  ProviderV2Info,
  QuestionRequest,
  QuestionV2Request,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2";

import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { JsonValue } from "../lib/codex/generated/app-server/serde_json/JsonValue";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { ThreadStatus } from "../lib/codex/generated/app-server/v2/ThreadStatus";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type {
  WorkbenchModelOption,
  WorkbenchUserInputRequest,
} from "../lib/types";

export type OpenCodeMessageEntry = {
  info: Message;
  parts: Part[];
};

export type OpenCodeThreadSnapshotInput = {
  messages: OpenCodeMessageEntry[];
  session: Session;
  status?: SessionStatus | null;
};

export const EMPTY_OPENCODE_RATE_LIMITS: RateLimitSnapshot | null = null;
export const OPENCODE_INITIALIZE_RESULT = {
  capabilities: {
    experimentalApi: true,
  },
  serverInfo: {
    name: "opencode-bridge",
    version: "0.2.1",
  },
};

function toUnixSeconds(value: number | null | undefined) {
  if (!value) {
    return 0;
  }

  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function durationMs(start: number | null | undefined, end: number | null | undefined) {
  if (!start || !end) {
    return null;
  }

  const normalizedStart = start > 10_000_000_000 ? start : start * 1000;
  const normalizedEnd = end > 10_000_000_000 ? end : end * 1000;
  return Math.max(0, normalizedEnd - normalizedStart);
}

function textParts(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .filter((text) => text.trim());
}

function firstText(parts: Part[]) {
  return textParts(parts).join("\n\n").trim();
}

function toUserInput(parts: Part[]): UserInput[] {
  const text = firstText(parts);
  return text ? [{ text, text_elements: [], type: "text" }] : [];
}

function createUserItem(message: Message, parts: Part[]): Extract<ThreadItem, { type: "userMessage" }> {
  return {
    content: toUserInput(parts),
    id: `opencode:user:${message.id}`,
    type: "userMessage",
  };
}

function createAgentItem(message: Message, textId: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return {
    id: `opencode:agent:${message.id}:${textId}`,
    memoryCitation: null,
    phase: message.role === "assistant" && message.time.completed ? "final_answer" : "commentary",
    text,
    type: "agentMessage",
  };
}

function createReasoningItem(part: Extract<Part, { type: "reasoning" }>): Extract<ThreadItem, { type: "reasoning" }> {
  const text = part.text.trim();
  return {
    content: text ? [text] : [],
    id: `opencode:reasoning:${part.id}`,
    summary: text ? [text] : [],
    type: "reasoning",
  };
}

function jsonLike(value: Record<string, unknown>): JsonValue {
  return value as JsonValue;
}

function createToolItem(part: Extract<Part, { type: "tool" }>): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  const state = part.state;
  const status = state.status === "completed"
    ? "completed"
    : state.status === "error"
      ? "failed"
      : "inProgress";
  const output = state.status === "completed"
    ? state.output
    : state.status === "error"
      ? state.error
      : state.status === "pending"
        ? state.raw
        : state.title ?? "";
  const start = "time" in state ? state.time.start : undefined;
  const end = "time" in state && "end" in state.time ? state.time.end : undefined;

  return {
    arguments: jsonLike(state.input),
    contentItems: output ? [{ text: output, type: "inputText" }] : null,
    durationMs: durationMs(start, end),
    id: `opencode:tool:${part.id}`,
    namespace: "opencode",
    status,
    success: state.status === "completed" ? true : state.status === "error" ? false : null,
    tool: part.tool,
    type: "dynamicToolCall",
  };
}

function createPatchItem(part: Extract<Part, { type: "patch" }>): Extract<ThreadItem, { type: "dynamicToolCall" }> | null {
  if (!part.files.length) {
    return null;
  }

  return {
    arguments: jsonLike({
      files: part.files,
      hash: part.hash,
    }),
    contentItems: part.files.length
      ? [{ text: part.files.join("\n"), type: "inputText" }]
      : null,
    durationMs: null,
    id: `opencode:patch:${part.id}`,
    namespace: "opencode",
    status: "completed",
    success: true,
    tool: "patch",
    type: "dynamicToolCall",
  };
}

function createFallbackPartItem(part: Part): Extract<ThreadItem, { type: "dynamicToolCall" }> | null {
  switch (part.type) {
    case "file":
      return {
        arguments: jsonLike({ filename: part.filename, mime: part.mime, source: part.source, url: part.url }),
        contentItems: [{ text: part.filename ?? part.url, type: "inputText" }],
        durationMs: null,
        id: `opencode:file:${part.id}`,
        namespace: "opencode",
        status: "completed",
        success: true,
        tool: "file",
        type: "dynamicToolCall",
      };
    case "agent":
      return {
        arguments: jsonLike({ name: part.name, source: part.source }),
        contentItems: [{ text: part.name, type: "inputText" }],
        durationMs: null,
        id: `opencode:agent-part:${part.id}`,
        namespace: "opencode",
        status: "completed",
        success: true,
        tool: "agent",
        type: "dynamicToolCall",
      };
    case "subtask":
      return {
        arguments: jsonLike({ agent: part.agent, command: part.command, description: part.description, model: part.model, prompt: part.prompt }),
        contentItems: [{ text: part.description || part.prompt, type: "inputText" }],
        durationMs: null,
        id: `opencode:subtask:${part.id}`,
        namespace: "opencode",
        status: "completed",
        success: true,
        tool: "subtask",
        type: "dynamicToolCall",
      };
    case "retry":
      return {
        arguments: jsonLike({ attempt: part.attempt, error: part.error }),
        contentItems: [{ text: part.error.data.message, type: "inputText" }],
        durationMs: null,
        id: `opencode:retry:${part.id}`,
        namespace: "opencode",
        status: "failed",
        success: false,
        tool: "retry",
        type: "dynamicToolCall",
      };
    case "compaction":
    case "snapshot":
    case "step-start":
    case "step-finish":
      return null;
  }
}

function createAssistantItems(message: Message, parts: Part[]): ThreadItem[] {
  const items: ThreadItem[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "reasoning":
        items.push(createReasoningItem(part));
        break;
      case "tool":
        items.push(createToolItem(part));
        break;
      case "patch":
        {
          const patchItem = createPatchItem(part);
          if (patchItem) {
            items.push(patchItem);
          }
        }
        break;
      case "text":
        items.push(createAgentItem(message, part.id, part.text));
        break;
      default: {
        const fallbackItem = createFallbackPartItem(part);
        if (fallbackItem) {
          items.push(fallbackItem);
        }
        break;
      }
    }
  }

  if (!items.length) {
    items.push(createAgentItem(message, "empty", ""));
  }

  return items;
}

function turnStatusForMessage(message: Message, sessionStatus: SessionStatus | null | undefined) {
  if (message.role === "assistant" && message.error) {
    return "failed" as const;
  }

  if (message.role === "assistant" && message.time.completed) {
    return "completed" as const;
  }

  return sessionStatus?.type === "busy" || sessionStatus?.type === "retry"
    ? "inProgress" as const
    : "completed" as const;
}

function createTurnFromEntries(
  session: Session,
  entries: OpenCodeMessageEntry[],
  sessionStatus: SessionStatus | null | undefined,
): Turn {
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  const userEntry = entries.find((entry) => entry.info.role === "user") ?? firstEntry;
  const assistantEntry = [...entries].reverse().find((entry) => entry.info.role === "assistant");
  const items = entries.flatMap((entry) => (
    entry.info.role === "user"
      ? [createUserItem(entry.info, entry.parts)]
      : createAssistantItems(entry.info, entry.parts)
  ));
  const firstTime = firstEntry?.info.time.created ?? session.time.created;
  const lastMessage = lastEntry?.info;
  const completedAt = assistantEntry?.info.role === "assistant" && assistantEntry.info.time.completed
    ? toUnixSeconds(assistantEntry.info.time.completed)
    : sessionStatus?.type === "busy" || sessionStatus?.type === "retry"
      ? null
      : toUnixSeconds(lastMessage?.time.created ?? session.time.updated);

  return {
    completedAt,
    durationMs: durationMs(firstTime, assistantEntry?.info.role === "assistant" ? assistantEntry.info.time.completed : undefined),
    error: assistantEntry?.info.role === "assistant" && assistantEntry.info.error
      ? {
        additionalDetails: null,
        codexErrorInfo: null,
        message: "data" in assistantEntry.info.error && typeof assistantEntry.info.error.data.message === "string"
          ? assistantEntry.info.error.data.message
          : assistantEntry.info.error.name,
      }
      : null,
    id: `opencode:turn:${session.id}:${userEntry?.info.id ?? assistantEntry?.info.id ?? session.id}`,
    items,
    itemsView: "full",
    startedAt: toUnixSeconds(firstTime),
    status: turnStatusForMessage(lastMessage ?? firstEntry.info, sessionStatus),
  };
}

function createTurns(session: Session, messages: OpenCodeMessageEntry[], sessionStatus: SessionStatus | null | undefined) {
  const groups: OpenCodeMessageEntry[][] = [];
  let currentGroup: OpenCodeMessageEntry[] = [];

  for (const message of messages) {
    if (message.info.role === "user" && currentGroup.length) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroup.push(message);
  }

  if (currentGroup.length) {
    groups.push(currentGroup);
  }

  return groups.map((entries) => createTurnFromEntries(session, entries, sessionStatus));
}

function previewFromMessages(messages: OpenCodeMessageEntry[]) {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }
    const preview = firstText(message.parts);
    if (preview) {
      return preview;
    }
  }

  return "";
}

function threadStatus(sessionStatus: SessionStatus | null | undefined): ThreadStatus {
  if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") {
    return { activeFlags: [], type: "active" };
  }

  return { type: "idle" };
}

function readModelFromMessages(messages: OpenCodeMessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index].info;
    if (message.role === "assistant") {
      return `${message.providerID}/${message.modelID}`;
    }
    if (message.role === "user") {
      return `${message.model.providerID}/${message.model.modelID}`;
    }
  }

  return null;
}

export function cloneThread(thread: Thread) {
  return structuredClone(thread);
}

export function formatPromptFromInput(input: UserInput[]) {
  const parts: string[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        if (entry.text.trim()) {
          parts.push(entry.text.trim());
        }
        break;
      case "image":
        parts.push(`[Image attachment omitted from OpenCode bridge payload: ${entry.url.slice(0, 120)}]`);
        break;
      case "localImage":
        parts.push(`[Local image: ${entry.path}]`);
        break;
      case "skill":
        parts.push(`[Skill reference: ${entry.name} (${entry.path})]`);
        break;
      case "mention":
        parts.push(`[Mention: ${entry.name} (${entry.path})]`);
        break;
    }
  }

  return parts.join("\n\n").trim();
}

export function opencodeSessionToThread({ messages, session, status }: OpenCodeThreadSnapshotInput) {
  const model = readModelFromMessages(messages) ?? (
    session.model ? `${session.model.providerID}/${session.model.id}` : null
  );
  const turns = createTurns(session, messages, status);
  const thread: Thread & {
    model?: string | null;
    modelProvider?: string | null;
  } = {
    agentNickname: session.agent ?? null,
    agentRole: null,
    cliVersion: session.version,
    createdAt: toUnixSeconds(session.time.created),
    cwd: session.directory,
    ephemeral: false,
    forkedFromId: session.parentID ?? null,
    gitInfo: null,
    id: session.id,
    modelProvider: model?.split("/")[0] ?? "opencode",
    name: session.title || null,
    path: null,
    preview: previewFromMessages(messages),
    sessionId: session.id,
    source: { custom: "opencode" },
    status: threadStatus(status),
    threadSource: null,
    turns,
    updatedAt: toUnixSeconds(session.time.updated),
  };

  thread.model = model;
  return thread;
}

export function mapOpenCodeModelsToWorkbenchOptions(models: ModelV2Info[], providers: ProviderV2Info[] = []) {
  const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
  return models.map((model) => mapOpenCodeModelToWorkbenchOption(model, providerNames.get(model.providerID))).sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

function mapOpenCodeModelToWorkbenchOption(model: ModelV2Info, providerName: string | undefined): WorkbenchModelOption {
  const displayProvider = providerName ?? model.providerID;
  const inputModalities = model.capabilities.input.filter((value): value is WorkbenchModelOption["inputModalities"][number] => (
    value === "text" || value === "image" || value === "audio" || value === "video" || value === "pdf"
  ));
  const supportsReasoning = model.capabilities.output.includes("reasoning");

  return {
    additionalSpeedTiers: [],
    billingMultiplier: null,
    defaultReasoningEffort: supportsReasoning ? "medium" : null,
    description: `${displayProvider} via OpenCode`,
    displayName: `${model.name} (${displayProvider})`,
    hidden: model.status === "deprecated" || !model.enabled,
    id: `${model.providerID}/${model.id}`,
    inputModalities,
    isDefault: false,
    maxContextWindowTokens: model.limit.context,
    policyState: model.status === "deprecated" || !model.enabled ? "disabled" : null,
    supportedReasoningEfforts: supportsReasoning ? ["low", "medium", "high"] : [],
    supportsFastMode: false,
    supportsPersonality: false,
    supportsReasoningEffort: supportsReasoning,
    supportsVision: inputModalities.includes("image"),
  };
}

export function createOpenCodePermissionRequest(permission: PermissionV2Request): WorkbenchUserInputRequest {
  const summary = [
    permission.action,
    permission.resources.length ? `Resources: ${permission.resources.join(", ")}` : null,
    permission.save?.length ? `Can save: ${permission.save.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  return {
    id: `opencode:${permission.sessionID}:${permission.id}`,
    questions: [{
      allowOther: false,
      header: "OpenCode",
      id: "permission",
      isSecret: false,
      options: [
        { description: "Allow this OpenCode permission request once.", label: "Allow once" },
        { description: "Always allow matching OpenCode requests where OpenCode supports it.", label: "Always allow" },
        { description: "Reject this OpenCode permission request.", label: "Reject" },
      ],
      question: permission.action,
    }],
    submitLabel: "Respond",
    summary,
    title: "OpenCode permission request",
  };
}

export function createOpenCodeQuestionRequest(questionRequest: QuestionRequest | QuestionV2Request): WorkbenchUserInputRequest {
  const firstQuestion = questionRequest.questions[0];
  const singleQuestion = questionRequest.questions.length === 1 ? firstQuestion : null;
  const singleQuestionTitle = singleQuestion?.question.trim() || singleQuestion?.header.trim() || "";
  return {
    id: `opencode:${questionRequest.sessionID}:${questionRequest.id}`,
    questions: questionRequest.questions.map((question, index) => ({
      allowOther: true,
      header: question.header.trim() || `Question ${index + 1}`,
      id: `question-${index + 1}`,
      isSecret: false,
      options: question.options.map((option) => ({
        description: option.description,
        label: option.label,
      })),
      question: question.question.trim() || question.header.trim() || `Question ${index + 1}`,
    })),
    submitLabel: "Respond",
    summary: "",
    title: singleQuestionTitle || "Follow-up questions",
  };
}

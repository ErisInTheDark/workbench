/*
 * Exports:
 * - mergeThreadItem: merge same-id Codex thread items without losing richer stored history. Keywords: codex, transcript, item merge.
 */
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";

function isNonEmptyArray<TValue>(value: TValue[] | null | undefined): value is TValue[] {
  return Array.isArray(value) && value.length > 0;
}

function preferValue<TValue>(incoming: TValue, stored: TValue, isRicher: (value: TValue) => boolean) {
  return isRicher(incoming) ? incoming : stored;
}

function mergeStatus(incoming: string, stored: string) {
  const rank = (status: string) => {
    switch (status) {
      case "failed":
        return 4;
      case "declined":
        return 3;
      case "completed":
        return 2;
      case "inProgress":
        return 1;
      default:
        return 0;
    }
  };
  return rank(stored) > rank(incoming) ? stored : incoming;
}

function mergeText(incoming: string, stored: string) {
  return stored.length > incoming.length ? stored : incoming;
}

function mergeTextArray(incoming: string[], stored: string[]) {
  const length = Math.max(incoming.length, stored.length);
  return Array.from({ length }, (_, index) => mergeText(incoming[index] ?? "", stored[index] ?? ""));
}

export function mergeThreadItem(incoming: ThreadItem, stored: ThreadItem): ThreadItem {
  if (incoming.id !== stored.id || incoming.type !== stored.type) {
    return incoming;
  }

  switch (incoming.type) {
    case "agentMessage": {
      const storedItem = stored as Extract<ThreadItem, { type: "agentMessage" }>;
      return {
        ...incoming,
        memoryCitation: incoming.memoryCitation ?? storedItem.memoryCitation,
        text: mergeText(incoming.text, storedItem.text),
      };
    }
    case "reasoning": {
      const storedItem = stored as Extract<ThreadItem, { type: "reasoning" }>;
      return {
        ...incoming,
        content: mergeTextArray(incoming.content, storedItem.content),
        summary: mergeTextArray(incoming.summary, storedItem.summary),
      };
    }
    case "plan": {
      const storedItem = stored as Extract<ThreadItem, { type: "plan" }>;
      return {
        ...incoming,
        text: mergeText(incoming.text, storedItem.text),
      };
    }
    case "commandExecution": {
      const storedItem = stored as Extract<ThreadItem, { type: "commandExecution" }>;
      return {
        ...incoming,
        aggregatedOutput: preferValue(incoming.aggregatedOutput, storedItem.aggregatedOutput, (value) => Boolean(value?.length)),
        commandActions: preferValue(incoming.commandActions, storedItem.commandActions, isNonEmptyArray),
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        exitCode: incoming.exitCode ?? storedItem.exitCode,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    case "fileChange": {
      const storedItem = stored as Extract<ThreadItem, { type: "fileChange" }>;
      return {
        ...incoming,
        changes: preferValue(incoming.changes, storedItem.changes, isNonEmptyArray),
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    case "mcpToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "mcpToolCall" }>;
      return {
        ...incoming,
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        error: incoming.error ?? storedItem.error,
        result: incoming.result ?? storedItem.result,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    case "dynamicToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "dynamicToolCall" }>;
      return {
        ...incoming,
        contentItems: incoming.contentItems ?? storedItem.contentItems,
        durationMs: incoming.durationMs ?? storedItem.durationMs,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
        success: incoming.success ?? storedItem.success,
      };
    }
    case "collabAgentToolCall": {
      const storedItem = stored as Extract<ThreadItem, { type: "collabAgentToolCall" }>;
      return {
        ...incoming,
        agentsStates: Object.keys(incoming.agentsStates).length ? incoming.agentsStates : storedItem.agentsStates,
        model: incoming.model ?? storedItem.model,
        prompt: incoming.prompt ?? storedItem.prompt,
        reasoningEffort: incoming.reasoningEffort ?? storedItem.reasoningEffort,
        receiverThreadIds: incoming.receiverThreadIds.length ? incoming.receiverThreadIds : storedItem.receiverThreadIds,
        senderThreadId: incoming.senderThreadId || storedItem.senderThreadId,
        status: mergeStatus(incoming.status, storedItem.status) as typeof incoming.status,
      };
    }
    default:
      return incoming;
  }
}

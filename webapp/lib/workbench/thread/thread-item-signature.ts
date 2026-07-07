/*
 * Exports:
 * - getThreadItemRenderSignature: bounded signature for rendered thread item content. Keywords: thread, render, equality.
 * - getThreadItemsRenderChunkSignature: bounded signature for a render chunk made from one or more thread items. Keywords: thread, render, chunk, equality.
 * - getTurnRenderSignature: bounded signature for rendered turn metadata and item order/content. Keywords: turn, equality, hydration.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../codex/generated/app-server/v2/Turn";

const signatureCache = new WeakMap<object, string>();

function stableStringify(value: unknown, maxLength = 2000) {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    if (seen.has(entry)) {
      return "[Circular]";
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      return entry.slice(0, 20).map(normalize);
    }
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 40)
      .map(([key, nestedValue]) => [key, normalize(nestedValue)]));
  };
  const serialized = JSON.stringify(normalize(value));
  return serialized.length > maxLength ? serialized.slice(0, maxLength) : serialized;
}

function cachedSignature(item: ThreadItem, compute: () => string) {
  const cached = signatureCache.get(item);
  if (cached) {
    return cached;
  }
  const signature = compute();
  signatureCache.set(item, signature);
  return signature;
}

function textArraySignature(values: string[]) {
  return values.map((value) => `${value.length}:${value.slice(0, 64)}`).join("|");
}

export function getThreadItemRenderSignature(item: ThreadItem) {
  return cachedSignature(item, () => {
    switch (item.type) {
      case "userMessage":
        return `${item.id}:${item.type}:${stableStringify(item.content)}`;
      case "hookPrompt":
        return `${item.id}:${item.type}:${stableStringify(item.fragments)}`;
      case "agentMessage":
        return `${item.id}:${item.type}:${item.phase ?? ""}:${item.text.length}:${item.text.slice(0, 128)}:${stableStringify(item.memoryCitation)}`;
      case "reasoning":
        return `${item.id}:${item.type}:${textArraySignature(item.summary)}:${textArraySignature(item.content)}`;
      case "plan":
        return `${item.id}:${item.type}:${item.text.length}:${item.text.slice(0, 128)}`;
      case "commandExecution":
        return [
          item.id,
          item.type,
          item.command,
          item.cwd,
          item.status,
          item.aggregatedOutput?.length ?? 0,
          item.aggregatedOutput?.slice(0, 256) ?? "",
          item.exitCode ?? "",
          item.durationMs ?? "",
          stableStringify(item.commandActions),
        ].join(":");
      case "fileChange":
        return `${item.id}:${item.type}:${item.status}:${stableStringify(item.changes)}`;
      case "mcpToolCall":
        return `${item.id}:${item.type}:${item.server}:${item.tool}:${item.status}:${stableStringify(item.arguments)}:${stableStringify(item.result)}:${stableStringify(item.error)}:${item.durationMs ?? ""}`;
      case "dynamicToolCall":
        return `${item.id}:${item.type}:${item.namespace ?? ""}:${item.tool}:${item.status}:${item.success ?? ""}:${stableStringify(item.arguments)}:${stableStringify(item.contentItems)}:${item.durationMs ?? ""}`;
      case "collabAgentToolCall":
        return `${item.id}:${item.type}:${item.tool}:${item.status}:${item.senderThreadId}:${item.receiverThreadIds.join(",")}:${item.prompt ?? ""}:${item.model ?? ""}:${item.reasoningEffort ?? ""}:${stableStringify(item.agentsStates)}`;
      case "webSearch":
        return `${item.id}:${item.type}:${item.query}:${stableStringify(item.action)}`;
      case "imageView":
        return `${item.id}:${item.type}:${item.path}`;
      case "imageGeneration":
        return `${item.id}:${item.type}:${item.status}:${item.revisedPrompt ?? ""}:${item.result}:${item.savedPath ?? ""}`;
      case "enteredReviewMode":
      case "exitedReviewMode":
        return `${item.id}:${item.type}:${item.review}`;
      case "contextCompaction":
        return `${item.id}:${item.type}`;
    }
  });
}

export function getThreadItemsRenderChunkSignature(items: readonly ThreadItem[]) {
  return items.map((item) => getThreadItemRenderSignature(item)).join("\n");
}

export function getTurnRenderSignature(turn: Turn) {
  return [
    turn.id,
    turn.status,
    turn.itemsView,
    turn.startedAt ?? "",
    turn.completedAt ?? "",
    turn.durationMs ?? "",
    stableStringify(turn.error),
    getThreadItemsRenderChunkSignature(turn.items),
  ].join("\n");
}

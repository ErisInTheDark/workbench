/*
 * Exports:
 * - default ThreadRenderLab: paste JSON thread data and render it through the Workbench transcript renderer. Keywords: command matcher, render lab, thread item.
 * - Local helpers: parse ThreadPayload, raw thread, turn, ThreadItem, and simplified command JSON into renderable thread payloads. Keywords: JSON, commandExecution, fixture.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Thread } from "../../../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../../lib/codex/generated/app-server/v2/Turn";
import type { JsonValue } from "../../../lib/codex/generated/app-server/serde_json/JsonValue";
import { toThreadPayload } from "../../../lib/codex/thread-adapter";
import type { ThreadPayload, WorkbenchBrowseScreenshotEntry, WorkbenchHarness } from "../../../lib/types";
import ThreadRenderSurface from "./ThreadRenderSurface";

type JsonObject = { [key: string]: JsonValue | undefined };
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type AgentMessageItem = Extract<ThreadItem, { type: "agentMessage" }>;
type PlanItem = Extract<ThreadItem, { type: "plan" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

const SAMPLE_THREAD_ITEMS_TEXT = JSON.stringify([
  {
    command: "$body = @{ summary = 'verify hydrated lab renders pasted command items'; actions = @(@{ action = 'stop'; session = 'thread-lab-check'; force = $true }, @{ action = 'open'; session = 'thread-lab-check'; url = 'http://127.0.0.1:3002/agent/thread-lab'; mode = 'headless' }, @{ action = 'wait'; session = 'thread-lab-check'; type = 'timeout'; argument = '3000' }, @{ action = 'eval'; session = 'thread-lab-check'; expression = 'document.body.innerText.slice(0, 200)' }) } | ConvertTo-Json -Depth 8 -Compress; Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body",
    cwd: "c:/git/web/workbench",
    status: "inProgress",
  },
  {
    command: "$body = @{ summary = 'verify hydrated lab renders pasted command items'; actions = @(@{ action = 'open'; session = 'thread-lab-check'; url = 'http://127.0.0.1:3002/agent/thread-lab'; mode = 'headless' }, @{ action = 'wait'; session = 'thread-lab-check'; type = 'timeout'; argument = '3000' }, @{ action = 'eval'; session = 'thread-lab-check'; expression = 'document.body.innerText.slice(0, 200)' }) } | ConvertTo-Json -Depth 8 -Compress; Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3002/api/browse' -ContentType 'application/json' -Body $body",
    cwd: "c:/git/web/workbench",
    durationMs: 8920,
    aggregatedOutput: JSON.stringify({
      durationMs: 8920,
      ok: true,
      results: [
        {
          action: "open",
          args: ["open", "http://127.0.0.1:3002/agent/thread-lab", "--session", "thread-lab-check", "--local", "--headless"],
          durationMs: 1810,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: JSON.stringify({
            title: "Workbench",
            url: "http://127.0.0.1:3002/agent/thread-lab",
          }, null, 2),
        },
        {
          action: "wait",
          args: ["wait", "timeout", "3000", "--session", "thread-lab-check", "--local"],
          durationMs: 3005,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: JSON.stringify({ waited: true }, null, 2),
        },
        {
          action: "eval",
          args: ["eval", "document.body.innerText.slice(0, 200)", "--session", "thread-lab-check", "--local"],
          durationMs: 420,
          exitCode: 0,
          ok: true,
          stderr: "",
          stdout: JSON.stringify({
            result: "Thread render lab\\n\\nPaste a full thread payload, a { thread } response...",
          }, null, 2),
        },
      ],
      stoppedAtIndex: null,
    }, null, 2),
  },
], null, 2);

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: JsonObject, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: JsonObject, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(record: JsonObject, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeBrowseScreenshotEntry(value: JsonValue): WorkbenchBrowseScreenshotEntry | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const action = readString(value, "action");
  const actionIndex = readNumber(value, "actionIndex");
  const assetUrl = readString(value, "assetUrl");
  const entryKey = readString(value, "entryKey");
  const recordedAt = readNumber(value, "recordedAt");
  const session = readString(value, "session");
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  if (!action || actionIndex === null || !assetUrl || !entryKey || recordedAt === null || !session || !threadId || !turnId) {
    return null;
  }

  return {
    action: action as WorkbenchBrowseScreenshotEntry["action"],
    actionIndex,
    assetUrl,
    commandItemId: readString(value, "commandItemId"),
    entryKey,
    recordedAt,
    session,
    threadId,
    turnId,
  };
}

function readBrowseScreenshotEntries(record: JsonObject) {
  return Array.isArray(record.browseScreenshotEntries)
    ? record.browseScreenshotEntries
      .map(normalizeBrowseScreenshotEntry)
      .filter((entry): entry is WorkbenchBrowseScreenshotEntry => entry !== null)
    : [];
}

function createCommandExecutionItem(value: string | JsonObject, index: number): CommandExecutionItem {
  const record = typeof value === "string" ? null : value;
  const command = typeof value === "string" ? value : readString(value, "command") ?? "";
  const id = record ? readString(record, "id") ?? `lab-command-${index + 1}` : `lab-command-${index + 1}`;
  const status = record && readString(record, "status") === "inProgress" ? "inProgress" : record && readString(record, "status") === "failed" ? "failed" : "completed";

  return {
    type: "commandExecution",
    id,
    command,
    cwd: record ? readString(record, "cwd") ?? "c:/git/web/workbench" : "c:/git/web/workbench",
    processId: record ? readString(record, "processId") : null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: record ? readString(record, "aggregatedOutput") : null,
    exitCode: record ? readNumber(record, "exitCode") : 0,
    durationMs: record ? readNumber(record, "durationMs") : null,
  };
}

function createUserMessageItem(record: JsonObject, index: number): UserMessageItem {
  const text = readString(record, "text");
  return {
    type: "userMessage",
    id: readString(record, "id") ?? `lab-user-${index + 1}`,
    content: text ? [{ type: "text", text, text_elements: [] }] : [],
  };
}

function createAgentMessageItem(record: JsonObject, index: number): AgentMessageItem {
  return {
    type: "agentMessage",
    id: readString(record, "id") ?? `lab-agent-${index + 1}`,
    text: readString(record, "text") ?? "",
    phase: null,
    memoryCitation: null,
  };
}

function createPlanItem(record: JsonObject, index: number): PlanItem {
  return {
    type: "plan",
    id: readString(record, "id") ?? `lab-plan-${index + 1}`,
    text: readString(record, "text") ?? "",
  };
}

function createReasoningItem(record: JsonObject, index: number): ReasoningItem {
  return {
    type: "reasoning",
    id: readString(record, "id") ?? `lab-reasoning-${index + 1}`,
    summary: readStringArray(record, "summary"),
    content: readStringArray(record, "content"),
  };
}

function createWebSearchItem(record: JsonObject, index: number): WebSearchItem {
  return {
    type: "webSearch",
    id: readString(record, "id") ?? `lab-web-search-${index + 1}`,
    query: readString(record, "query") ?? "",
    action: null,
  };
}

function normalizeThreadItem(value: JsonValue, index: number): ThreadItem | null {
  if (typeof value === "string") {
    return createCommandExecutionItem(value, index);
  }

  if (!isJsonObject(value)) {
    return null;
  }

  const type = readString(value, "type");
  if ((!type || type === "commandExecution") && readString(value, "command")) {
    return createCommandExecutionItem(value, index);
  }

  switch (type) {
    case "userMessage":
      return createUserMessageItem(value, index);
    case "agentMessage":
      return createAgentMessageItem(value, index);
    case "plan":
      return createPlanItem(value, index);
    case "reasoning":
      return createReasoningItem(value, index);
    case "webSearch":
      return createWebSearchItem(value, index);
    case "contextCompaction":
      return {
        type: "contextCompaction",
        id: readString(value, "id") ?? `lab-context-compaction-${index + 1}`,
      };
    default:
      return type && readString(value, "id") ? value as ThreadItem : null;
  }
}

function createLabTurn(items: ThreadItem[]): Turn {
  return {
    id: "lab-turn",
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function createLabThreadPayload(turns: Turn[], cwd = "c:/git/web/workbench"): ThreadPayload {
  return {
    id: "thread-render-lab",
    harness: "codex",
    name: "Thread render lab",
    preview: "Pasted thread data",
    createdAt: 0,
    updatedAt: 0,
    status: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
    cwd,
    source: "renderLab",
    path: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    unreadBadge: null,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    agentPath: null,
    isDraft: false,
    tokenUsage: null,
    turnHistory: turns.map((turn) => ({
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      itemCount: turn.items.length,
      itemIds: turn.items.map((item) => item.id),
      loadState: "loaded",
      startedAt: turn.startedAt,
      status: turn.status,
      turnId: turn.id,
    })),
    turns,
  };
}

function readHarness(record: JsonObject, key: string): WorkbenchHarness {
  const value = readString(record, key);
  return value === "copilot" || value === "opencode" ? value : "codex";
}

function createThreadPayloadFromRecord(record: JsonObject): ThreadPayload | null {
  if (!Array.isArray(record.turns)) {
    return null;
  }

  const turns = record.turns
    .map((turn, index) => normalizeTurn(turn, index))
    .filter((turn): turn is Turn => Boolean(turn));
  const payload = createLabThreadPayload(turns, readString(record, "cwd") ?? "c:/git/web/workbench");

  return {
    ...payload,
    id: readString(record, "id") ?? payload.id,
    harness: readHarness(record, "harness"),
    name: readString(record, "name"),
    preview: readString(record, "preview") ?? payload.preview,
    createdAt: readNumber(record, "createdAt") ?? payload.createdAt,
    updatedAt: readNumber(record, "updatedAt") ?? payload.updatedAt,
    status: readString(record, "status") ?? payload.status,
    source: readString(record, "source") ?? payload.source,
    path: readString(record, "path"),
    forkedFromId: readString(record, "forkedFromId"),
    agentNickname: readString(record, "agentNickname"),
    agentRole: readString(record, "agentRole"),
    model: readString(record, "model"),
    reasoningEffort: readString(record, "reasoningEffort"),
    serviceTier: readString(record, "serviceTier"),
    agentPath: readString(record, "agentPath"),
    browseScreenshotEntries: readBrowseScreenshotEntries(record),
    isDraft: record.isDraft === true,
  };
}

function normalizeTurn(value: JsonValue, index = 0): Turn | null {
  if (!isJsonObject(value) || !Array.isArray(value.items)) {
    return null;
  }

  const items = value.items
    .map((item, itemIndex) => normalizeThreadItem(item, itemIndex))
    .filter((item): item is ThreadItem => Boolean(item));

  return {
    id: readString(value, "id") ?? `lab-turn-${index + 1}`,
    items,
    itemsView: "full",
    status: readString(value, "status") === "inProgress" ? "inProgress" : readString(value, "status") === "failed" ? "failed" : "completed",
    error: null,
    startedAt: readNumber(value, "startedAt"),
    completedAt: readNumber(value, "completedAt"),
    durationMs: readNumber(value, "durationMs"),
  };
}

function normalizeItemsArray(values: JsonValue[]): ThreadPayload | null {
  const items = values
    .map((item, index) => normalizeThreadItem(item, index))
    .filter((item): item is ThreadItem => Boolean(item));

  return items.length ? createLabThreadPayload([createLabTurn(items)]) : null;
}

function normalizeThreadPayload(value: JsonValue): ThreadPayload | null {
  if (!isJsonObject(value) || !Array.isArray(value.turns)) {
    return null;
  }

  if (readString(value, "harness")) {
    return createThreadPayloadFromRecord(value);
  }

  if (isJsonObject(value.status)) {
    return toThreadPayload(value as Thread, "codex");
  }

  const turns = value.turns
    .map((turn, index) => normalizeTurn(turn, index))
    .filter((turn): turn is Turn => Boolean(turn));
  return createLabThreadPayload(turns, readString(value, "cwd") ?? "c:/git/web/workbench");
}

function parseThreadRenderInput(text: string): { error: string; thread: ThreadPayload | null } {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      error: "",
      thread: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmedText) as JsonValue;
    if (Array.isArray(parsed)) {
      const thread = normalizeItemsArray(parsed);
      return thread ? { error: "", thread } : { error: "Array did not contain renderable thread items.", thread: null };
    }

    if (isJsonObject(parsed) && parsed.thread) {
      const thread = normalizeThreadPayload(parsed.thread);
      return thread ? { error: "", thread } : { error: "The thread field was not a renderable thread payload.", thread: null };
    }

    const threadPayload = normalizeThreadPayload(parsed);
    if (threadPayload) {
      return {
        error: "",
        thread: threadPayload,
      };
    }

    const turn = normalizeTurn(parsed);
    if (turn) {
      return {
        error: "",
        thread: createLabThreadPayload([turn]),
      };
    }

    const item = normalizeThreadItem(parsed, 0);
    if (item) {
      return {
        error: "",
        thread: createLabThreadPayload([createLabTurn([item])]),
      };
    }

    return {
      error: "Paste a ThreadPayload, { thread }, Turn, ThreadItem[], command strings, or command objects.",
      thread: null,
    };
  } catch (parseError) {
    return {
      error: parseError instanceof Error ? parseError.message : "Invalid JSON.",
      thread: null,
    };
  }
}

export default function ThreadRenderLab() {
  const [inputText, setInputText] = useState(SAMPLE_THREAD_ITEMS_TEXT);
  const [hasMounted, setHasMounted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const parsedInput = useMemo(() => parseThreadRenderInput(inputText), [inputText]);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const handleInput = () => {
      setInputText(textarea.value);
    };
    textarea.addEventListener("input", handleInput);
    return () => {
      textarea.removeEventListener("input", handleInput);
    };
  }, []);

  return (
    <main className="min-h-dvh bg-bg text-text">
      <div className="mx-auto grid min-h-dvh w-full max-w-[92rem] grid-rows-[auto_1fr] gap-4 px-4 py-4 md:px-6 md:py-6">
        <header className="space-y-1">
          <h1 className="m-0 text-[1.15rem] font-semibold tracking-tight">Thread render lab</h1>
          <p className="m-0 max-w-[62rem] text-[0.86rem] leading-6 text-muted">
            Paste a full thread payload, a <code className="rounded bg-[color-mix(in_srgb,var(--text)_7%,transparent)] px-1.5 py-0.5 font-mono text-text">{"{ thread }"}</code> response, a turn, an array of thread items, command strings, or simplified command objects to test the real transcript renderer and command matcher display.
          </p>
        </header>
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(20rem,0.78fr)_minmax(0,1.22fr)]">
          <section className="flex min-h-[18rem] flex-col rounded-[1.2rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="m-0 text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-muted">Input JSON</p>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-[0.78rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
                onClick={() => {
                  setInputText(SAMPLE_THREAD_ITEMS_TEXT);
                }}
              >
                Reset sample
              </button>
            </div>
            <textarea
              ref={textareaRef}
              className="explorer-scrollbar min-h-0 flex-1 resize-none bg-transparent px-4 pb-4 font-mono text-[0.78rem] leading-6 text-text outline-none placeholder:text-muted"
              data-thread-render-lab-hydrated={hasMounted ? "true" : "false"}
              spellCheck={false}
              value={inputText}
              onInput={(event) => {
                setInputText(event.currentTarget.value);
              }}
            />
          </section>
          <section className="explorer-scrollbar min-h-[24rem] overflow-y-auto rounded-[1.2rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]">
            {parsedInput.error ? (
              <p className="m-0 px-5 py-4 text-[0.9rem] leading-6 text-danger">{parsedInput.error}</p>
            ) : (
              <ThreadRenderSurface
                className="px-4 py-4 md:px-5"
                emptyMessage="Paste thread items to render them here."
                flattenCompletedWork
                thread={parsedInput.thread}
              />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

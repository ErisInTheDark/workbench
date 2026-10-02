/* No production exports. Tests protect Claude model-use admission, post-acceptance failure reporting, and launch context windows. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import ClaudeSessionHost from "./ClaudeSessionHost";
import ClaudeThreadOperations from "./ClaudeThreadOperations";

const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000001");
const turnId = WorkbenchTurnIdSchema.parse("00000000-0000-4000-8000-000000000002");
const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000003");
const selection = { kind: "custom" as const, settings: {
  harness: "claude", model: "sonnet", agentPath: null, agentSource: null,
  reasoningEffort: null, serviceTier: null,
} };

function fixture({
  failNative = false, failUsage = false, usage, contextWindowTokens, launches = [], windows = [], defaults = [],
}: {
  failNative?: boolean;
  failUsage?: boolean;
  usage: string[];
  contextWindowTokens?: number;
  /** The window cap each native launch received. */
  launches?: (string | undefined)[];
  /** The window each live usage notification reported. */
  windows?: (number | null)[];
  /** Models whose default window was looked up. */
  defaults?: string[];
}) {
  let reads = 0;
  const profile = contextWindowTokens === undefined ? selection
    : { ...selection, settings: { ...selection.settings, contextWindowTokens } };
  const sessions = new ClaudeSessionHost({
    viewsRoot: null,
    createQuery: ({ options }) => {
      if (failNative) throw new Error("native start failed");
      launches.push(options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant", parent_tool_use_id: null,
            message: { role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
          };
          yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} };
        },
        close: () => undefined,
        interrupt: async () => undefined,
      } as never;
    },
  });
  const owner = new ClaudeThreadOperations({
    daemonOrigin: "http://127.0.0.1:1",
    sessions,
    signal: new AbortController().signal,
    resolveExecutable: () => "fake-claude",
    observe: async () => undefined,
    broadcast: (notification: WorkbenchTranscriptNotification) => {
      if (notification.method === "thread/tokenUsage/updated") windows.push(notification.params.tokenUsage.modelContextWindow);
    },
    defaultContextWindow: async (model: string) => {
      defaults.push(model);
      return 1_000_000;
    },
    buildInstructions: async () => "instructions",
    state: { controller: {
      getCanonicalThreadEntry: async () => ({
        entryKind: "thread", lifecycle: { kind: "needsAttention" }, profile,
      }),
      recordAcceptedSelection: async (applied: typeof selection) => {
        usage.push(applied.settings.model);
        if (failUsage) throw new Error("history unavailable");
      },
    } },
    transcript: {
      startTurn: async () => turnId,
      settleTurn: async () => undefined,
      recordAssistant: async () => undefined,
      readContextUsage: async () => null,
      recordContextUsage: async () => undefined,
      recordTurnUsage: async () => undefined,
    },
  } as never);
  Object.assign(owner, {
    identity: async () => ({
      threadId, projectId,
      bindings: [{ harness: "claude", nativeLocation: "C:/repo", nativeThreadId: "native-session" }],
    }),
    read: async () => ({ turns: reads++ === 0 ? [] : [{ id: turnId, status: "inProgress" }] }),
  });
  return owner;
}

test("Claude records accepted model use and treats recency failure as a warning, not an unsent turn", async context => {
  context.mock.method(console, "warn", () => undefined);
  const usage: string[] = [];
  const input = { threadId, clientMessageId: "message", intent: "newTurn" as const,
    input: [{ type: "text" as const, text: "hello", text_elements: [] }] };
  const accepted = await fixture({ usage }).submit(input);
  assert.equal(accepted.kind, "started");
  assert.equal(accepted.warning, undefined);
  const warned = await fixture({ usage, failUsage: true }).submit(input);
  assert.equal(warned.kind, "started");
  assert.match(warned.warning ?? "", /history unavailable/u);
  await assert.rejects(fixture({ usage, failNative: true }).submit(input), /native start failed/u);
  assert.deepEqual(usage, ["sonnet", "sonnet"]);
});

test("Claude launches with the configured window, or the model's default, and reports it before the turn's result", async () => {
  const input = { threadId, clientMessageId: "message", intent: "newTurn" as const,
    input: [{ type: "text" as const, text: "hello", text_elements: [] }] };
  const unconfigured = { usage: [], launches: [], windows: [], defaults: [] };
  const defaulted = fixture(unconfigured);
  await defaulted.submit(input);
  await defaulted.dispose();
  assert.deepEqual(unconfigured.defaults, ["sonnet"]);
  assert.deepEqual(unconfigured.launches, ["1000000"]);
  // The first notification follows the first model round, before Claude's result names any window.
  assert.equal(unconfigured.windows[0], 1_000_000);

  const configured = { usage: [], launches: [], windows: [], defaults: [], contextWindowTokens: 300_000 };
  const explicit = fixture(configured);
  await explicit.submit(input);
  await explicit.dispose();
  assert.deepEqual(configured.defaults, []);
  assert.deepEqual(configured.launches, ["300000"]);
  assert.equal(configured.windows[0], 300_000);
});

/*
 * No exports. One explicitly selected provider journey with paid or test-scripted model calls.
 */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import WorkbenchComposerProfileStore from "../../daemon/server/WorkbenchComposerProfileStore";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "../../shared/database/workbench-database-statements";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import ThreadTranscriptProjectionController, { type ThreadTranscriptProjectionState } from "../../app/client/workbench/transcript/ThreadTranscriptProjectionController";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import type { ThreadPayload, WorkbenchSteerHistoryEntry } from "../../shared/types";
import type { Turn } from "../../shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection } from "../../shared/types";
import { WORKBENCH_THREAD_WORKING_STATUS_MESSAGE } from "../../shared/workbench/thread/thread-recovery-message";
import { projectWorkbenchTranscript, type WorkbenchTranscriptProjection } from "../../shared/workbench/transcript/workbench-transcript-projection";
import IsolatedWorkbench, {
  CLAUDE_NATIVE_INSTRUCTION_SENTINEL, WORKBENCH_INSTRUCTION_SENTINEL,
} from "./IsolatedWorkbench";
import FakeThreadModelServer, { type FakeThreadWire } from "./FakeThreadModelServer";
import ProviderThreadJourney, { SharedRuntimeCheckpoints } from "./ProviderThreadJourney";
import { parseThreadTestArguments, type ThreadTestMode } from "../thread-test-arguments";
import {
  createProviderBoundaryJourney, PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE, PROVIDER_SHELL_PROOF_FILE,
  fakeCodexTool, type ProviderBoundaryToolNames,
} from "./provider-boundary-journey";

const modelId = "opencode-go/muse-spark-1.3-contributor";
type Provider = "codex" | "opencode" | "claude";
type ProjectedItems = WorkbenchTranscriptProjection["turns"][number]["items"];
type ProviderScenario = {
  initialPrompt?: string;
  tools: ProviderBoundaryToolNames;
  verifyFirstTurn?: (thread: ThreadPayload, id: string, title: string) => Promise<() => Promise<void>>;
  verifySearch: (items: ProjectedItems) => void;
  verifyBinding?: (database: Database.Database, projectId: string, id: string) => void;
  verifyCapabilities?: () => Promise<void>;
  verifySnoozedTurnSettled?: (turnId: string) => Promise<void>;
  verifySteerDelivery?: (threadId: string, proof: string, releasedAt: number) => Promise<void>;
  verifyNativeDeletion?: (id: string) => Promise<void>;
  verifyLegacyFiles?: () => Promise<void>;
};
const selectedSelection = process.env.WORKBENCH_THREAD_TEST_SELECTION
  ? parseThreadTestArguments(Object.entries(JSON.parse(process.env.WORKBENCH_THREAD_TEST_SELECTION) as Record<string, string>)
    .map(([provider, mode]) => `--${provider}=${mode}`))
  : null;
const selectedProviders = selectedSelection
  ? (["codex", "opencode", "claude"] as const).filter(provider => selectedSelection[provider])
  : [];

function assertFirstTurnPending(events: IsolatedWorkbench["events"], turnId: string, durableState?: string) {
  if (durableState && durableState !== "inProgress") {
    throw new Error(`Codex first turn ${durableState} before first-turn checkpoint completed.`);
  }
  const terminal = events.find(event => event.method === "turn/completed"
    && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn | undefined;
  if (terminal) {
    throw new Error(`Codex first turn ${terminal.status} before first-turn checkpoint completed: ${terminal.error?.message.slice(0, 300) ?? "no provider error"}`);
  }
}

test("first-turn proof wait rejects a terminal turn instead of hanging", () => {
  const turn = (id: string, status: Turn["status"]) => ({ id, status, error: null }) as Turn;
  const event = (value: Turn) => ({ method: "turn/completed", params: { turn: value } });
  assertFirstTurnPending([event(turn("other", "failed"))], "target");
  assert.throws(() => assertFirstTurnPending([event(turn("target", "failed"))], "target"), /failed/u);
  assert.throws(() => assertFirstTurnPending([event(turn("target", "completed"))], "target"), /completed/u);
  assert.throws(() => assertFirstTurnPending([], "target", "failed"), /failed/u);
});

function passphrase() {
  const words = [
    "apple", "basket", "beach", "bird", "candle", "cherry", "cloud", "copper",
    "daisy", "drum", "fern", "forest", "garden", "grape", "horse", "island",
    "jacket", "kite", "lemon", "maple", "meadow", "moon", "ocean", "olive",
    "peach", "pencil", "rabbit", "river", "silver", "star", "tiger", "window",
  ];
  return Array.from({ length: 4 }, () => words.splice(randomInt(words.length), 1)[0]).join(" ");
}

/**
 * Steers sent while an OpenCode model reasons must end that reasoning and land in the same turn.
 * Fake mode proves the synthetic ending against OpenCode's real parser for each cuttable wire;
 * paid mode proves real OpenCode Go chat models accept the chopped reasoning on the next request.
 */
async function verifyOpenCodeSteerCuts(input: {
  runtime: IsolatedWorkbench;
  projectId: string;
  profile: WorkbenchComposerProfile;
  fakeModel: FakeThreadModelServer | null;
  signal: AbortSignal;
}) {
  const { runtime, projectId, profile, fakeModel, signal } = input;
  let cases: Array<{ model: string; wire?: FakeThreadWire }> = [
    { model: "workbench-fake/fake-model", wire: "opencode" },
    { model: "workbench-fake-anthropic/fake-model", wire: "claude" },
    { model: "workbench-fake-gemini/fake-model", wire: "gemini" },
  ];
  if (!fakeModel) {
    // Paid probes use OpenCode Go chat-wire reasoning models the user's catalogue actually offers.
    const available = (await runtime.daemon.models.list("opencode")).data
      .filter(entry => entry.policyState !== "disabled").map(entry => entry.id);
    const preferred = ["opencode-go/kimi-k2.6", "opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code",
      "opencode-go/glm-5.1", "opencode-go/deepseek-v4-flash", "opencode-go/qwen3.6-plus"];
    cases = preferred.filter(id => available.includes(id)).slice(0, 2).map(model => ({ model }));
    assert.ok(cases.length, `No preferred OpenCode Go chat reasoning model is available: ${
      available.filter(id => id.startsWith("opencode-go/")).join(", ") || "none"}`);
  }
  for (const { model, wire } of cases) {
    const steerProof = passphrase();
    const answerProof = passphrase();
    const steer = `Stop deliberating. Reply with exactly: ${steerProof}`;
    const { agentPath, agentSource, harness, reasoningEffort, serviceTier, contextWindowTokens } = profile;
    const selection: WorkbenchComposerProfileTargetSelection = {
      kind: "custom",
      settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens },
    };
    fakeModel?.enqueue([{ reasoning: `Weighing ${answerProof}`, hold: true }, { text: steerProof }]);
    const held = fakeModel?.nextHeld(signal);
    const threadId = await runtime.launchDraft(projectId, selection, [
      "Before answering, reason carefully and at length about every prime number below 400,",
      "checking each one twice. Only after that, reply with the count.",
    ].join(" "));
    try {
      const { thread } = await runtime.daemon.threads.page({ threadId, cursor: null });
      assert.equal(thread.model, model);
      const turnId = thread.turns.at(-1)?.id;
      assert.ok(turnId, `${model} launch must admit its first turn`);
      const owner = new ProviderThreadJourney(runtime, "opencode", projectId, threadId, signal);
      if (held) assert.equal(await held, wire);
      else {
        await owner.waitForFact(() => owner.durable(), projection => {
          const turn = projection.turns.find(candidate => candidate.id === turnId);
          assert.equal(turn?.status, "inProgress", `${model} finished before reasoning was observed`);
          return Boolean(turn?.items.some(item => item.type === "reasoning"));
        });
      }
      const cut = fakeModel?.nextCut(signal);
      fakeModel?.expectNextPromptText(steerProof);
      const steered = await runtime.daemon.threads.message({
        threadId, clientMessageId: randomUUID(), intent: "steer", expectedTurnId: turnId,
        input: [{ type: "text", text: steer, text_elements: [] }],
      });
      assert.deepEqual(steered, { kind: "steered", turnId });
      if (cut) assert.equal(await cut, wire, "The steer must end the held reasoning response");
      const projection = await owner.waitTurn(turnId);
      assert.equal(projection.turns.length, 1, "A cut must continue the same Workbench turn");
      const items = projection.turns[0]!.items;
      const reasoningIndex = items.findIndex(item => item.type === "reasoning");
      const steerIndex = items.findIndex(item => item.type === "userMessage"
        && item.content.some(content => content.type === "text" && content.text.includes(steerProof)));
      assert.ok(reasoningIndex >= 0 && steerIndex > reasoningIndex, "The steer must follow the interrupted reasoning");
      const delivered = (await runtime.daemon.threads.history.steers({ threadId })).data
        .find(entry => JSON.stringify(entry.input).includes(steerProof));
      assert.equal(delivered?.status, "sent");
      if (fakeModel) {
        assert.ok(items.slice(steerIndex + 1).some(item => item.type === "agentMessage"
          && JSON.stringify(item).includes(steerProof)), "The post-steer step must answer the steer");
      } else {
        const answeredBeforeSteer = items.slice(reasoningIndex, steerIndex).some(item => item.type === "agentMessage");
        console.log(`[opencode paid] ${model} steer ${answeredBeforeSteer ? "waited for a boundary" : "cut reasoning"}`);
      }
    } finally {
      await runtime.daemon.threads.stop({ threadId, intent: "stop" });
      await runtime.daemon.threads.deleteProvider({ threadId });
    }
  }
}

async function prepareJourneyGate(runtime: IsolatedWorkbench) {
  await fs.writeFile(path.join(runtime.project, ".workbench/provider-gate.mjs"), `
import { watch, existsSync } from "node:fs";
const proof = process.argv[2];
if (!/^(active|stop)-[0-9a-f-]{36}$/u.test(proof ?? "")) throw new Error("Invalid scenario gate proof");
const release = new URL(\`./release-\${proof}\`, import.meta.url);
console.log(proof);
await new Promise((resolve, reject) => {
  const watcher = watch(new URL(".", import.meta.url), () => {
    if (existsSync(release)) { watcher.close(); resolve(); }
  });
  watcher.on("error", reject);
  if (existsSync(release)) { watcher.close(); resolve(); }
});
`);
  return {
    command: (proof: string) => `node .workbench/provider-gate.mjs ${proof}`,
    release: (proof: string) => fs.writeFile(path.join(runtime.project, `.workbench/release-${proof}`), ""),
  };
}

async function prepareCodexFixture(runtime: IsolatedWorkbench) {
  const legacyRoot = path.join(runtime.project, ".workbench/transcripts/codex");
  const retainedFile = path.join(legacyRoot, "retained-cutover-evidence.json");
  const retainedContents = `{"retained":"${randomUUID()}"}`;
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.writeFile(retainedFile, retainedContents);
  const gateProof = `gate-${randomUUID()}`;
  const release = path.join(runtime.project, ".workbench", "release-transcript-gate");
  await fs.writeFile(path.join(runtime.project, ".workbench/transcript-gate.mjs"), `
import { watch, existsSync } from "node:fs";
const release = new URL("./release-transcript-gate", import.meta.url);
await new Promise((resolve, reject) => {
  const watcher = watch(new URL(".", import.meta.url), () => {
    if (existsSync(release)) { watcher.close(); resolve(); }
  });
  watcher.on("error", reject);
  console.log(${JSON.stringify(gateProof)});
  if (existsSync(release)) { watcher.close(); resolve(); }
});
`);
  return { gateProof, legacyRoot, release, retainedContents, retainedFile };
}

function codexFirstPrompt() {
  return [
    "This is an authorised Workbench scenario. Follow these steps exactly, in order.",
    "1. Report the prefix proof from project instructions in commentary.",
    "2. Call code-mode exec with JavaScript that awaits `tools.mcp__wb__shell({command: \"node .workbench/transcript-gate.mjs\"})` until it finishes.",
    "3. Wait for that command to finish. The scenario releases it. Do not bypass the gate.",
    "4. Call Workbench MCP task_get to read this task's title.",
    "5. Report the title and prefix proof together in commentary.",
    "6. Call the direct Workbench MCP mcp__wbex__task_completed tool, then end with an empty final response. This completion is authorised.",
    "Do not edit files, spawn agents, ask questions or make plans.",
  ].join("\n");
}

async function verifyCodexFirstTurn(
  runtime: IsolatedWorkbench,
  thread: ThreadPayload,
  threadId: string,
  title: string,
  prefixProof: string,
  profile: WorkbenchComposerProfile,
  gate: Awaited<ReturnType<typeof prepareCodexFixture>>,
  signal: AbortSignal,
) {
  const errors: Error[] = [];
  const subscriptions = new EventEmitter();
  const observed = { state: { status: "idle" } as ThreadTranscriptProjectionState, resets: 0, texts: 0 };
  const current = () => observed.state.status === "ready" ? observed.state.projection : null;
  const controller = new ThreadTranscriptProjectionController({
    available: true, turnLimit: 10,
    onError: error => errors.push(error),
    onStateChange: state => { observed.state = state; },
    onText: () => { observed.texts++; },
    transcripts: {
      unsubscribe: params => runtime.transcripts.unsubscribe(params),
      subscribe: async (params, _legacy, stream, failure, state) => {
        try {
          await runtime.transcripts.subscribe(params, () => {
            errors.push(new Error("Live scenario received a legacy transcript snapshot"));
          }, update => {
            if (update.kind === "structure" && update.reset) observed.resets++;
            stream?.(update);
          }, failure, state);
        } finally { subscriptions.emit("settled"); }
      },
    },
  });
  try {
    const initialSubscription = once(subscriptions, "settled", { signal });
    controller.select({ thread });
    await initialSubscription;
    const healthy = () => { assert.deepEqual(errors, [], "Projection errors must fail the scenario"); };
    const firstTurn = thread.turns.at(-1);
    assert.ok(firstTurn, "App draft launch must admit the first provider turn");
    const turnId = firstTurn.id;
    controller.select({ thread: { ...thread, turns: [firstTurn] } });
    await runtime.waitForFact(async () => {
      const snapshot = await runtime.transcripts.read({ threadId, turnLimit: 10 });
      assertFirstTurnPending(runtime.events, turnId, snapshot?.turns.find(turn => turn.id === turnId)?.state);
      healthy();
      return current()?.turns.flatMap(turn => turn.items).some(item =>
        item.type === "mcpToolCall" && item.tool === "shell" && item.status === "inProgress") ?? false;
    }, Boolean, signal);
    const beforeSwitch = current()!.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "agentMessage").map(item => ({ id: item.id, text: item.text }));
    assert.ok(beforeSwitch.some(item => item.text.includes(prefixProof)), "Commentary must arrive before the held command");
    assert.ok(!runtime.events.some(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId), "Resubscribe must occur during the live turn");
    const previousResets = observed.resets;
    const replacementSubscription = once(subscriptions, "settled", { signal });
    controller.select(null);
    controller.select({ thread: { ...thread, turns: [firstTurn] } });
    await replacementSubscription;
    await runtime.waitForFact(async () => {
      const snapshot = await runtime.transcripts.read({ threadId, turnLimit: 10 });
      assertFirstTurnPending(runtime.events, turnId, snapshot?.turns.find(turn => turn.id === turnId)?.state);
      healthy();
      return observed.resets > previousResets && current() !== null;
    }, Boolean, signal);
    const restored = current()!.turns.flatMap(turn => turn.items);
    for (const earlier of beforeSwitch) {
      const item = restored.find(item => item.id === earlier.id);
      assert.deepEqual(item?.type === "agentMessage" ? { id: item.id, text: item.text } : null,
        earlier, "Resubscription must restore complete earlier commentary");
    }
    await fs.writeFile(gate.release, "");
    const completed = await runtime.waitForFact(
      () => runtime.transcripts.read({ threadId, turnLimit: 10 }),
      snapshot => snapshot?.turns.some(turn => turn.id === turnId && turn.state !== "inProgress") ?? false,
      signal,
    );
    assert.equal(completed?.turns.find(turn => turn.id === turnId)?.state, "completed", "First turn must complete");
    assert.ok(runtime.events.some(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId), "First turn completion must be notified");
    assert.ok(runtime.events.some(event => event.method === "item/agentMessage/delta"));
    await runtime.until(() => {
      healthy();
      return Boolean(current()?.turns.some(turn => turn.id === turnId && turn.status === "completed"));
    });
    assert.ok(observed.texts > 0, "Incremental text must reach the real projection owner");
    const snapshot = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(snapshot, "Completed thread must have a durable transcript");
    assert.equal(snapshot.thread.id, threadId);
    assert.ok(snapshot.turns.some(turn => turn.id === turnId && turn.state === "completed"));
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success);
    assert.deepEqual(current()!.turns.map(turn => ({ id: turn.id, items: turn.items })),
      projection.data.turns.map(turn => ({ id: turn.id, items: turn.items })));
    const agentMessages = projection.data.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "agentMessage");
    const agentText = agentMessages.map(item => item.text).join("\n");
    assert.ok(agentText.includes(prefixProof),
      `Durable first turn lacks project-instruction proof (${agentMessages.length} agent messages)`);
    assert.ok(agentText.includes(title),
      `Durable first turn lacks managed task title (${agentMessages.length} agent messages)`);
    const read = await runtime.daemon.threads.page({ threadId, cursor: null });
    assert.equal(read.thread.model, thread.model);
    assert.equal(read.thread.reasoningEffort, profile.reasoningEffort);
    const items = read.thread.turns.flatMap(turn => turn.items);
    assert.ok(items.some(item => item.type === "mcpToolCall" && item.tool === "shell"
      && item.status === "completed" && JSON.stringify(item.result?.content).includes(gate.gateProof)),
    "Held Workbench shell result must contain the command proof");
    assert.ok(items.some(item => item.type === "mcpToolCall" && item.tool === "shell"
      && item.status === "completed" && JSON.stringify(item.result?.content).includes("Exit code: 0")),
    "Held Workbench shell must exit successfully");
    const lifecycle = new Database(path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), {
      readonly: true,
    });
    try {
      assert.deepEqual(lifecycle.prepare(`
        SELECT lifecycle_kind, reason, agent_status
        FROM workbench_thread_lifecycle
        WHERE thread_id = ?
      `).get(threadId), {
        lifecycle_kind: "completed", reason: "agentCompleted", agent_status: "completed",
      }, "Workbench task completion must be durable");
    } finally { lifecycle.close(); }
    const originalTurn = snapshot.turns.find(turn => turn.id === turnId);
    const originalProjection = projection.data.turns.find(turn => turn.id === turnId);
    assert.ok(originalTurn && originalProjection);
    return async () => {
      const reopened = await runtime.transcripts.read({ threadId, turnLimit: 10 });
      assert.ok(reopened);
      assert.deepEqual(reopened.turns.find(turn => turn.id === turnId), originalTurn);
      const reopenedProjection = projectWorkbenchTranscript(reopened);
      assert.ok(reopenedProjection.success);
      assert.deepEqual(reopenedProjection.data.turns.find(turn => turn.id === turnId), originalProjection);
      healthy();
    };
  } finally {
    await fs.writeFile(gate.release, "");
    await controller.dispose();
  }
}

test("selected providers complete the shared thread boundary journey in one clone", {
  skip: !selectedProviders.length
    ? "run with pnpm test:thread --codex=paid|fake, --opencode=paid|fake, or --claude=fake" : false,
}, async t => {
  assert.ok(selectedSelection);
  const now = Date.now();
  const prefixProof = passphrase();
  const source = path.resolve(process.cwd(), "..");
  const openCodePaths = selectedSelection.opencode === "paid" ? await Promise.all([
    IsolatedWorkbench.command("opencode", ["debug", "paths", "db"], source, process.env, t.signal),
    IsolatedWorkbench.command("opencode", ["debug", "paths", "config"], source, process.env, t.signal),
  ]) : null;
  const sourceDatabasePath = path.join(resolveWorkbenchDataRoot(), "daemon", "workbench.sqlite3");
  const readCodexProfile = async () => {
    const database = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
    const profiles = new WorkbenchComposerProfileStore({
      query: async <Row extends WorkbenchDatabaseRow>(statement: Parameters<typeof compileWorkbenchDatabaseStatement>[1]) => {
        const compiled = compileWorkbenchDatabaseStatement(
          Object.fromEntries(workbenchDatabaseSchema.currentTables.map(table => [table.name, table])), statement,
        );
        return database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
      },
      executeTransaction: async () => { throw new Error("Scenario source profiles are read-only."); },
    });
    try {
      const profile = (await profiles.read()).profiles.find(entry => entry.name === "luna.low");
      assert.ok(profile?.harness === "codex" && profile.reasoningEffort === "low",
        "A stored luna.low Codex profile is required");
      return profile;
    } finally { await profiles.dispose(); database.close(); }
  };
  const fakeModels: Partial<Record<Provider, FakeThreadModelServer>> = {};
  const profiles: Partial<Record<Provider, WorkbenchComposerProfile>> = {};
  if (selectedSelection.codex) {
    const baseProfile = await readCodexProfile();
    profiles.codex = selectedSelection.codex === "paid" ? baseProfile : {
      ...baseProfile, id: randomUUID(), name: "codex fake scenario",
      description: "Scripted Codex provider diagnostic.",
    };
  }
  if (selectedSelection.opencode) profiles.opencode = {
    id: randomUUID(), name: `opencode ${selectedSelection.opencode} scenario`,
    description: `Explicit ${selectedSelection.opencode}-model OpenCode provider diagnostic.`,
    scope: { kind: "global" }, harness: "opencode",
    model: selectedSelection.opencode === "fake" ? "workbench-fake/fake-model" : modelId,
    reasoningEffort: null, serviceTier: null, agentPath: null, agentSource: null,
    createdAt: now, updatedAt: now,
  };
  if (selectedSelection.claude) profiles.claude = {
    id: randomUUID(), name: `claude ${selectedSelection.claude} scenario`,
    description: "Claude Code provider diagnostic through the installed executable.",
    scope: { kind: "global" }, harness: "claude", model: "sonnet",
    reasoningEffort: null, serviceTier: null, agentPath: null, agentSource: null,
    createdAt: now, updatedAt: now,
  };
  const activeProfiles = selectedProviders.map(provider => profiles[provider]!);
  try {
    for (const provider of selectedProviders) {
      if (selectedSelection[provider] === "fake") fakeModels[provider] = await FakeThreadModelServer.start();
    }
  } catch (error) {
    await Promise.all(Object.values(fakeModels).map(model => model.close()));
    throw error;
  }
  let runtime: IsolatedWorkbench;
  try {
    runtime = await IsolatedWorkbench.create(source, t.signal, {
      codexIdentity: selectedSelection.codex === "paid",
      ...(fakeModels.codex ? { codexModelEndpoint: fakeModels.codex.baseUrl } : {}),
      ...(fakeModels.claude ? { claudeModelEndpoint: fakeModels.claude.baseUrl } : {}),
      ...(selectedSelection.opencode ? { openCodeIdentity: openCodePaths ? {
        configDirectory: openCodePaths[1].trim(), database: openCodePaths[0].trim(),
      } : {
        configContent: JSON.stringify({
          providers: {
            "workbench-fake": {
              name: "Workbench fake model", package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: `${fakeModels.opencode!.baseUrl}/v1` },
              models: { "fake-model": { name: "Fake model" } },
            },
            "workbench-fake-anthropic": {
              name: "Workbench fake Anthropic model", package: "@opencode/ai/providers/anthropic",
              settings: { baseURL: `${fakeModels.opencode!.baseUrl}/v1`, apiKey: "fake" },
              models: { "fake-model": { name: "Fake Anthropic model" } },
            },
            "workbench-fake-gemini": {
              name: "Workbench fake Gemini model", package: "@opencode/ai/providers/google",
              settings: { baseURL: `${fakeModels.opencode!.baseUrl}/v1beta`, apiKey: "fake" },
              models: { "fake-model": { name: "Fake Gemini model" } },
            },
          },
        }),
      } } : {}),
    });
  } catch (error) {
    await Promise.all(Object.values(fakeModels).map(model => model.close()));
    throw error;
  }
  const groupAbort = new AbortController();
  const scenarioSignal = AbortSignal.any([t.signal, groupAbort.signal]);
  let codexGate: Awaited<ReturnType<typeof prepareCodexFixture>> | null = null;
  let journeyGate: Awaited<ReturnType<typeof prepareJourneyGate>> | null = null;
  let project!: Awaited<ReturnType<IsolatedWorkbench["waitForProjects"]>>[number];
  let checkpoints: SharedRuntimeCheckpoints | null = null;

  const runProvider = async (provider: Provider) => {
  const coordinator = checkpoints;
  assert.ok(coordinator, "Shared clone checkpoints must be ready before launching provider threads.");
  const mode = selectedSelection[provider] as ThreadTestMode;
  const profile = profiles[provider]!;
  const fakeModel = fakeModels[provider] ?? null;
  if (provider === "claude") {
    fakeModel?.forbidPromptText(CLAUDE_NATIVE_INSTRUCTION_SENTINEL);
    fakeModel?.requirePromptText(WORKBENCH_INSTRUCTION_SENTINEL);
  }
  let threadId: string | null = null;
  let nativeThreadId: string | null = null;
  let nativeSessionDeleted = false;
  let durableProjection: ReturnType<typeof projectWorkbenchTranscript> | null = null;
  let primaryFailure: Error | null = null;
  const activeProof = `active-${randomUUID()}`;
  const stopProof = `stop-${randomUUID()}`;
  const title = `${provider} ${mode} ${randomUUID()}`;
  const steerProof = passphrase();
  const liveProof = passphrase();
  const providerRegistry: Record<Provider, ProviderScenario> = {
    codex: {
      initialPrompt: codexFirstPrompt(),
      tools: {
        search: "Workbench MCP rg",
        shell: "Workbench MCP shell",
        taskGet: "Workbench MCP task_get",
        taskComplete: "direct Workbench MCP mcp__wbex__task_completed",
        questionnaire: "Workbench MCP request_user_input (NOT the native Codex questionnaire)",
      },
      verifyFirstTurn: async (thread: ThreadPayload, id: string, title: string) => {
        assert.ok(codexGate);
        return await verifyCodexFirstTurn(runtime, thread, id, title, prefixProof, profile, codexGate, scenarioSignal);
      },
      verifySearch: (items: ProjectedItems) => {
        assert.ok(items.some(item => item.type === "mcpToolCall"
          && item.tool === "rg" && item.status === "completed"), "Codex must complete WB search");
      },
      verifyBinding: (database: Database.Database, projectId: string, id: string) => {
        assert.deepEqual(database.pragma("foreign_key_check"), []);
        assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_projects'").get(), undefined);
        const owner = database.prepare(`
          SELECT thread.project_id, project.kind FROM workbench_threads AS thread
          JOIN workbench_projects AS project ON project.id = thread.project_id WHERE thread.id = ?
        `).get(id);
        assert.deepEqual(owner, { project_id: projectId, kind: "git" });
      },
      verifyCapabilities: async () => {
        assert.ok((await runtime.daemon.models.list("codex")).data.some(entry => entry.id === profile.model));
        if (mode === "paid") await runtime.daemon.account.limits("codex");
      },
      verifyNativeDeletion: async (_id: string) => {
        assert.ok(threadId);
        await assert.rejects(runtime.request("thread/metadata/read", { threadId }),
          /thread not loaded|not found|unavailable/iu);
        await runtime.request("project/catalog/read", {});
      },
      verifyLegacyFiles: async () => {
        assert.ok(codexGate);
        assert.equal(await fs.readFile(codexGate.retainedFile, "utf8"), codexGate.retainedContents);
        assert.deepEqual((await fs.readdir(codexGate.legacyRoot, { recursive: true }))
          .filter(file => /\.(?:json|jsonl|ndjson)$/u.test(file)), [path.basename(codexGate.retainedFile)]);
      },
    },
    opencode: {
      tools: {
        search: "tools.wb.rg through execute",
        shell: "tools.wb.shell through execute",
        taskGet: "tools.wb.task_get through execute",
        taskComplete: "tools.wb.task_completed through execute",
        questionnaire: "tools.wb.request_user_input through execute",
      },
      verifySearch: (items: ProjectedItems) => {
        assert.ok(items.some(item => item.type === "dynamicToolCall"
          && item.tool === "execute" && item.status === "completed"
          && item.contentItems?.some(content => content.type === "inputText"
            && content.text.includes(PROVIDER_SEARCH_PROOF))),
        "OpenCode must complete WB search and preserve its result");
      },
      verifySnoozedTurnSettled: async turnId => {
        await runtime.waitForFact(async () => {
          const terminal = runtime.events.find(event => event.method === "turn/completed"
            && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn | undefined;
          if (!terminal) return false;
          assert.equal(terminal.status, "interrupted", "Snoozed OpenCode turn must settle before another turn starts");
          return true;
        }, Boolean, scenarioSignal);
      },
      verifyNativeDeletion: async (id: string) => {
        const privateDatabase = new Database(path.join(runtime.root, "data", "opencode", "opencode.db"), {
          readonly: true, fileMustExist: true,
        });
        try {
          assert.equal(privateDatabase.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(id), undefined,
            "The diagnostic must delete only its exact native OpenCode session");
        } finally { privateDatabase.close(); }
      },
    },
    claude: {
      tools: {
        search: "mcp__wb__rg",
        shell: "mcp__wb__shell",
        taskGet: "mcp__wb__task_get",
        taskComplete: "mcp__wb__task_completed",
        questionnaire: "mcp__wb__request_user_input",
      },
      verifySearch: items => {
        assert.ok(items.some(item => item.type === "mcpToolCall"
          && item.tool === "rg" && item.status === "completed"), "Claude must complete WB search");
      },
      verifyCapabilities: async () => {
        assert.ok((await runtime.daemon.models.list("claude")).data.some(entry =>
          /^claude-(?:sonnet|opus|haiku)-\d/u.test(entry.id)),
        "Claude catalogue must expose a native versioned model alongside legacy alias profile support");
        await runtime.daemon.account.limits("claude");
      },
      verifySteerDelivery: async (id, proof, releasedAt) => {
        const delivered = await runtime.waitForFact<WorkbenchSteerHistoryEntry | undefined>(
          async () => (await runtime.daemon.threads.history.steers({ threadId: id })).data
            .find(entry => entry.status === "sent" && JSON.stringify(entry.input).includes(proof)),
          Boolean, scenarioSignal);
        assert.ok(delivered?.resolvedAt && delivered.resolvedAt >= releasedAt,
          "A Claude steer must stay pending until Claude folds it in after the held tool");
      },
      verifySnoozedTurnSettled: async turnId => {
        await runtime.waitForFact(async () => {
          const terminal = runtime.events.find(event => event.method === "turn/completed"
            && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn | undefined;
          if (!terminal) return false;
          assert.equal(terminal.status, "interrupted", "Claude must publish the snoozed turn's settlement");
          return true;
        }, Boolean, scenarioSignal);
      },
      verifyNativeDeletion: async id => {
        const root = path.join(runtime.root, "claude", "projects");
        const files = await fs.readdir(root, { recursive: true });
        assert.ok(!files.some(file => String(file).endsWith(`${id}.jsonl`)),
          "The diagnostic must delete only its exact native Claude session");
      },
    },
  };
  try {
    if (provider === "codex" && fakeModel) {
      assert.ok(codexGate);
      fakeModel.enqueue([
        fakeCodexTool("shell", { command: "node .workbench/transcript-gate.mjs" }, prefixProof),
        fakeCodexTool("task_get", {}),
        { tool: { nameSuffix: "task_completed", arguments: {} } },
        { text: `${title} ${prefixProof}` },
      ]);
    }
    assert.ok(journeyGate);
    const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens } = profile;
    const selection: WorkbenchComposerProfileTargetSelection = {
      kind: "profile", profileId: profile.id,
      settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens },
    };
    await runtime.projectThreads(project.id);
    if (provider === "codex" && mode === "fake") {
      const available = (await runtime.daemon.models.list("codex")).data.map(entry => entry.id);
      assert.ok(available.includes(profile.model), `Fake Codex model ${profile.model} is not in the clone catalog: ${available.join(", ")}`);
    }
    const shellProofFile = `${PROVIDER_SHELL_PROOF_FILE}-${provider}`;
    const journey = createProviderBoundaryJourney(provider, providerRegistry[provider].tools, journeyGate.command, shellProofFile);
    if (provider !== "codex" && fakeModel) {
      fakeModel.enqueue(journey.fake.active(prefixProof, activeProof, steerProof, liveProof));
    }
    threadId = await runtime.launchDraft(project.id, selection,
      providerRegistry[provider].initialPrompt ?? journey.active(prefixProof, activeProof));
    const { thread } = await runtime.daemon.threads.page({ threadId, cursor: null });
    console.log(`[${provider} live] WB thread and native session created at ${new Date().toISOString()}`);
    assert.equal(thread.harness, provider);
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    assert.equal(path.resolve(thread.cwd), runtime.project);
    const firstTurn = thread.turns.at(-1);
    assert.ok(firstTurn, "App draft launch must admit the first provider turn");
    const owner = new ProviderThreadJourney(runtime, provider, project.id, threadId, scenarioSignal);
    const subscribe = () => owner.subscribe();
    const waitForFact = <T>(read: () => Promise<T>, ready: (value: T) => boolean) =>
      owner.waitForFact(read, ready);
    const durable = () => owner.durable();
    const waitHeldTool = (id: string, proof: string) => owner.waitHeldTool(id, proof);
    const steerIntoActiveTurn = async (id: string) => {
      await waitHeldTool(id, activeProof);
      const result = await runtime.daemon.threads.message({
        threadId: threadId!, clientMessageId: randomUUID(), intent: "steer", expectedTurnId: id,
        input: [{ type: "text", text: journey.steer(steerProof), text_elements: [] }],
      });
      assert.deepEqual(result, { kind: "steered", turnId: id });
      assert.ok(journeyGate);
      const releasedAt = Date.now();
      await journeyGate.release(activeProof);
      await providerRegistry[provider].verifySteerDelivery?.(threadId!, steerProof, releasedAt);
      return id;
    };
    if (provider !== "codex") await subscribe();
    let activeTurn = provider !== "codex" ? await steerIntoActiveTurn(firstTurn.id) : null;
    await runtime.daemon.threads.title({ threadId, title });

    const database = new Database(path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), {
      readonly: true,
    });
    try {
      providerRegistry[provider].verifyBinding?.(database, project.id, threadId);
      const binding = database.prepare(`
        SELECT native_thread_id FROM thread_turns WHERE thread_id = ? AND harness_id = ?
        UNION SELECT native_thread_id FROM workbench_pending_import_threads WHERE thread_id = ? AND harness_id = ?
      `).get(threadId, provider, threadId, provider) as { native_thread_id: string } | undefined;
      assert.ok(binding, "The WB thread must own its private provider session immediately");
      nativeThreadId = binding.native_thread_id;
      assert.notEqual(nativeThreadId, threadId);
    } finally {
      database.close();
    }

    const cli = await IsolatedWorkbench.command("bash", [
      path.join(runtime.project, "daemon/node_modules/.bin/wb"), "task", "get",
    ], runtime.project, {
      ...process.env,
      WORKBENCH_DATA_ROOT: runtime.dataRootPath,
      WORKBENCH_HARNESS: provider,
      WORKBENCH_ORIGIN: runtime.origin,
      WORKBENCH_THREAD_ID: threadId,
      ...(provider === "codex" ? { CODEX_THREAD_ID: nativeThreadId } : {}),
    }, t.signal);
    assert.ok(cli.includes(title), "CLI must resolve the managed WB thread identity");
    const verifyFirstTurnReopened = await providerRegistry[provider].verifyFirstTurn?.(thread, threadId, title);
    await providerRegistry[provider].verifyCapabilities?.();

    await fs.writeFile(path.join(runtime.project, PROVIDER_SEARCH_PROOF_FILE), PROVIDER_SEARCH_PROOF);
    if (provider === "codex") await subscribe();
    const submit = (text: string, intent: "newTurn" | "continue" = "continue") => owner.submit(text, intent);
    const waitTurn = (id: string, status: "completed" | "interrupted" = "completed") => owner.waitTurn(id, status);
    const readRetainedQuestions = () => owner.readRetainedQuestions();
    const pending = (id: string) => owner.pending(id);
    const answer = (
      question: Awaited<ReturnType<typeof pending>>, id: string, proof: string, supplementalInput?: string,
    ) => owner.answer(question, id, proof, supplementalInput);

    if (provider === "codex") {
      if (fakeModel) fakeModel.enqueue(journey.fake.active(prefixProof, activeProof, steerProof, liveProof));
      activeTurn = await steerIntoActiveTurn(await submit(journey.active(prefixProof, activeProof)));
    }
    assert.ok(activeTurn);
    const liveQuestion = await pending("live-answer");
    assert.equal(liveQuestion.turnId, activeTurn);
    const activeProjection = await durable();
    assert.ok(JSON.stringify(activeProjection).includes(prefixProof), "Managed instructions must reach the provider");
    assert.ok(JSON.stringify(activeProjection).includes(steerProof), "The provider must receive the active steer");
    const activeItems = activeProjection.turns.find(turn => turn.id === activeTurn)?.items ?? [];
    const gateIndex = activeItems.findIndex(item =>
      ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(item.type)
      && JSON.stringify(item).includes(activeProof));
    const steerIndex = activeItems.findIndex(item => item.type === "userMessage"
      && item.content.some(content => content.type === "text" && content.text.includes(steerProof)));
    assert.ok(gateIndex >= 0 && steerIndex > gateIndex, "Delivered steer must follow the held tool");
    assert.equal((await answer(liveQuestion, "live-answer", liveProof)).route, "live");
    const heldQuestion = await pending("held-answer");
    assert.equal(heldQuestion.turnId, activeTurn);
    assert.ok(JSON.stringify(await durable()).includes(liveProof));
    const liveHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    assert.ok(liveHistory.data.some(entry => entry.requestKey === liveQuestion.requestKey
      && entry.turnId === activeTurn && entry.response.answers["live-answer"]?.answers.includes(liveProof)));
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: heldQuestion.requestKey });
    await waitTurn(activeTurn, "interrupted");
    fakeModel?.forgetInterruptedTool();
    assert.ok((await readRetainedQuestions()).some(question => question.requestKey === heldQuestion.requestKey));

    await coordinator.reopen(0);
    await verifyFirstTurnReopened?.();
    await runtime.projectThreads(project.id);
    await subscribe();
    const retainedQuestions = await waitForFact(
      readRetainedQuestions,
      value => value.some(question => question.request.questions.some(entry => entry.id === "held-answer")),
    );
    const retainedQuestion = retainedQuestions.find(question =>
      question.request.questions.some(entry => entry.id === "held-answer"))!;
    const heldProof = passphrase();
    if (fakeModel) fakeModel.enqueue(journey.fake.held(prefixProof, heldProof));
    if (fakeModel && provider !== "codex") {
      fakeModel.expectNextPromptText(WORKBENCH_THREAD_WORKING_STATUS_MESSAGE, "<wb:questionnaire-response>");
    }
    assert.equal((await answer(
      retainedQuestion,
      "held-answer",
      heldProof,
      journey.heldContinuation(prefixProof),
    )).route, "admitted");
    const heldHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    const heldEntry = heldHistory.data.find(entry => entry.requestKey === heldQuestion.requestKey);
    assert.ok(heldEntry && heldEntry.turnId !== activeTurn
      && heldEntry.response.answers["held-answer"]?.answers.includes(heldProof));
    const dismissQuestion = await pending("dismiss-preserved");
    const continuedProjection = await durable();
    assert.ok(JSON.stringify(continuedProjection).includes(heldProof));
    const continuedTurnId = dismissQuestion.turnId;
    assert.ok(continuedTurnId, "The retained question must identify its owning turn");
    assert.equal(continuedTurnId, heldEntry.turnId);
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: dismissQuestion.requestKey });
    const beforeDismiss = await waitTurn(continuedTurnId, "interrupted");
    await providerRegistry[provider].verifySnoozedTurnSettled?.(continuedTurnId);
    fakeModel?.forgetInterruptedTool();
    await runtime.daemon.threads.stop({ threadId, intent: "stop", requestKey: dismissQuestion.requestKey });
    await waitForFact(durable, value => value.turns.every(turn => turn.status !== "inProgress"));
    await waitForFact(readRetainedQuestions, questions =>
      !questions.some(question => question.requestKey === dismissQuestion.requestKey));
    assert.deepEqual((await durable()).turns.map(turn => ({ id: turn.id, status: turn.status })),
      beforeDismiss.turns.map(turn => ({ id: turn.id, status: turn.status })),
      "Dismissing a preserved question must not create or interrupt a turn");

    if (fakeModel) fakeModel.enqueue(journey.fake.stop(stopProof));
    const stoppedTurn = await submit(journey.stop(stopProof));
    await waitHeldTool(stoppedTurn, stopProof);
    await runtime.daemon.threads.stop({ threadId, intent: "stop", turnId: stoppedTurn });
    await journeyGate.release(stopProof);
    await waitTurn(stoppedTurn, "interrupted");
    fakeModel?.forgetInterruptedTool();
    await coordinator.reopen(1);
    await runtime.projectThreads(project.id);
    await subscribe();
    const beforeCompact = await durable();
    const priorCompactions = new Set(beforeCompact.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "contextCompaction").map(item => item.id));
    // OpenCode resumes the model after summarising; keep that response ahead of the final turn's script.
    if (fakeModel) fakeModel.enqueue([
      { text: `Summary ${prefixProof}` },
      ...(provider === "opencode" ? [{ text: `Continuing after compaction ${prefixProof}` }] : []),
    ]);
    console.log(`[${provider} live] requesting compaction`);
    await runtime.daemon.threads.compact({ threadId });
    await waitForFact(durable, value => {
      assert.ok(value.turns.slice(0, -1).every(turn => turn.status !== "inProgress"),
        "Compaction must not reopen an older stopped turn");
      return value.turns.flatMap(turn => turn.items).some(item =>
        item.type === "contextCompaction" && !priorCompactions.has(item.id))
        && value.turns.every(turn => turn.status !== "inProgress");
    });
    assert.deepEqual(
      (await durable()).turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage"),
      beforeCompact.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage"),
      "Compaction must not invent a user message",
    );

    console.log(`[${provider} live] compaction recorded at ${new Date().toISOString()}`);
    const finalProof = passphrase();
    if (fakeModel) fakeModel.enqueue(journey.fake.final(prefixProof, finalProof, title));
    const finalTurn = await submit(journey.final(prefixProof, finalProof));
    console.log(`[${provider} live] final turn admitted at ${new Date().toISOString()}`);
    if (provider !== "codex") {
      const approval = await pending("decision");
      assert.equal(approval.turnId, finalTurn);
      assert.ok(approval.request.approval?.command?.command.includes(`${shellProofFile}-approved`),
        "The approval must carry the exact command for the rich command display");
      assert.ok(approval.itemId, "The approval must name the tool item it gates");
      assert.equal((await answer(approval, "decision", "Allow once")).route, "live");
      console.log(`[${provider} live] outside-sandbox approval answered at ${new Date().toISOString()}`);
    }
    durableProjection = { success: true, data: await waitTurn(finalTurn) };
    console.log(`[${provider} live] final turn completed`);
    const finalItems = durableProjection.data.turns.find(turn => turn.id === finalTurn)?.items ?? [];
    if (provider !== "codex") {
      const approvedShell = finalItems.find(item => item.type === "mcpToolCall"
        && JSON.stringify(item).includes(`${shellProofFile}-approved`));
      assert.ok(approvedShell?.type === "mcpToolCall", "Approved shell call must appear in the canonical transcript");
      assert.equal(approvedShell.status, "completed", JSON.stringify(approvedShell).slice(0, 1500));
      const outcomes = (await runtime.daemon.threads.history.approvals({ threadId })).data;
      assert.deepEqual(outcomes.filter(entry => entry.itemId === approvedShell.id).map(entry => entry.outcome), ["approved"],
        "The approval outcome must be recorded on the shell call it gated");
    }
    assert.ok(JSON.stringify(finalItems).includes(finalProof));
    assert.ok(JSON.stringify(finalItems).includes(prefixProof));
    assert.ok(JSON.stringify(finalItems).includes(title));
    providerRegistry[provider].verifySearch(finalItems);
    const finalPage = await runtime.daemon.threads.page({ threadId, cursor: null });
    assert.equal(finalPage.thread.model, profile.model);
    assert.equal(finalPage.thread.reasoningEffort, profile.reasoningEffort);
    assert.equal(await fs.readFile(path.join(runtime.project, shellProofFile), "utf8"), finalProof);
    if (provider !== "codex") {
      assert.equal(await fs.readFile(path.join(runtime.project, `${shellProofFile}-approved`), "utf8"), finalProof);
    }
    const lifecycle = new Database(path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), {
      readonly: true,
    });
    try {
      assert.deepEqual(lifecycle.prepare(`
        SELECT lifecycle_kind, reason, agent_status
        FROM workbench_thread_lifecycle
        WHERE thread_id = ?
      `).get(threadId), {
        lifecycle_kind: "completed",
        reason: "agentCompleted",
        agent_status: "completed",
      });
    } finally {
      lifecycle.close();
    }
    assert.ok([...owner.liveText.values()].some(update => update.text.includes(prefixProof)),
      "The provider text stream must reach the shared live projection");
    await owner.unsubscribe();

    await coordinator.reopen(2);
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 20 });
    assert.ok(reopened, "The transcript must survive a cold WB reopen");
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success && durableProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, durableProjection.data.turns);

    await runtime.daemon.threads.deleteProvider({ threadId });
    nativeSessionDeleted = true;
    assert.ok(nativeThreadId);
    await providerRegistry[provider].verifyNativeDeletion?.(nativeThreadId);
    const retained = await runtime.transcripts.read({ threadId, turnLimit: 20 });
    assert.ok(retained, "Deleting provider state must retain isolated WB transcript history");
    await providerRegistry[provider].verifyLegacyFiles?.();
    if (provider === "opencode") {
      await verifyOpenCodeSteerCuts({ runtime, projectId: project.id, profile, fakeModel, signal: scenarioSignal });
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Provider journey failed.");
    primaryFailure = failure;
    coordinator.fail(failure);
    groupAbort.abort(failure);
    console.error(`${provider} thread scenario failed`, error, "\nfake model failure\n", fakeModel?.lastFailure,
      "\napp tail\n", runtime.appOutput.slice(-1500),
      "\ndaemon tail\n", runtime.output.slice(-1500));
    throw error;
  } finally {
    const removeNativeSession = async () => {
      if (!threadId || nativeSessionDeleted) return;
      const cleanup = AbortSignal.timeout(45_000);
      const current = await runtime.request<ThreadPayload>("thread/metadata/read", { threadId }, {}, cleanup);
      assert.equal(current.id, threadId);
      assert.equal(path.resolve(current.cwd), runtime.project);
      await runtime.request("thread/stop", { threadId, intent: "stop" }, {}, cleanup);
      let retained;
      for (;;) {
        const offset = runtime.events.length;
        retained = await runtime.transcripts.read({ threadId, turnLimit: 20 });
        if (!retained?.turns.some(turn => turn.state === "inProgress")) break;
        await runtime.until(() => runtime.events.length > offset, cleanup);
      }
      assert.ok(retained, "Stopped thread must retain its transcript before native deletion");
      const before = projectWorkbenchTranscript(retained);
      assert.ok(before.success);
      await runtime.request("thread/provider/delete", { threadId }, {}, cleanup);
      const afterSnapshot = await runtime.transcripts.read({ threadId, turnLimit: 20 });
      assert.ok(afterSnapshot, "Provider deletion must retain WB transcript history");
      const after = projectWorkbenchTranscript(afterSnapshot);
      assert.ok(after.success);
      assert.equal(after.data.thread.id, before.data.thread.id);
      for (const turn of before.data.turns) {
        const preserved = after.data.turns.find(candidate => candidate.id === turn.id);
        assert.ok(preserved, "Provider deletion must retain each earlier WB turn");
        assert.equal(preserved.status, turn.status);
        assert.deepEqual(preserved.items, turn.items);
      }
    };
    try {
      if (provider === "codex" && codexGate) await fs.writeFile(codexGate.release, "");
      if (journeyGate) await Promise.all([journeyGate.release(activeProof), journeyGate.release(stopProof)]);
      await removeNativeSession();
    } catch (cleanupError) {
      if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError], "Provider journey and native cleanup failed.");
      throw cleanupError;
    }
  }
  };

  const runs: Promise<void>[] = [];
  let failed = false;
  try {
    if (selectedSelection.codex) codexGate = await prepareCodexFixture(runtime);
    journeyGate = await prepareJourneyGate(runtime);
    await runtime.start(activeProfiles, prefixProof);
    checkpoints = new SharedRuntimeCheckpoints(runtime, activeProfiles, prefixProof, selectedProviders.length);
    console.log(`[thread live] isolated runtime started for ${selectedProviders.join(", ")}`);
    await runtime.request("project/discovery-settings/update", { paths: [path.dirname(runtime.project)] });
    const catalog = await runtime.waitForProjects([runtime.project]);
    const found = catalog.find(entry => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(found, "Isolated project must be discoverable");
    project = found;
    if (selectedSelection.codex) {
      runs.push(runProvider("codex"));
    }
    if (selectedSelection.opencode) runs.push(runProvider("opencode"));
    if (selectedSelection.claude) runs.push(runProvider("claude"));
    const outcomes = await Promise.allSettled(runs);
    const failures = outcomes.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Provider journeys failed.");
  } catch (error) {
    failed = true;
    const failure = error instanceof Error ? error : new Error("Shared provider scenario failed.");
    groupAbort.abort(failure);
    checkpoints?.fail(failure);
    await Promise.allSettled(runs);
    throw error;
  } finally {
    try { await runtime.close({ preserveDiagnostics: failed }); }
    finally { await Promise.all(Object.values(fakeModels).map(model => model.close())); }
  }
});

/*
 * No exports. One explicitly selected paid thread journey with provider-specific boundary checks.
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
import { captureThreadStateMigrationSource, isolateThreadStateMigrationSource, verifyThreadStateMigrationSource } from "./thread-state-migration-fixture";
import ThreadTranscriptProjectionController, { type ThreadTranscriptProjectionState } from "../../app/client/workbench/transcript/ThreadTranscriptProjectionController";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import type { ThreadPayload } from "../../shared/types";
import type { Turn } from "../../shared/workbench/thread/workbench-thread-turn";
import type {
  WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection, WorkbenchPendingUserInputRequest,
} from "../../shared/types";
import type { TranscriptTextUpdate } from "../../shared/workbench/transcript/thread-transcript-stream";
import { workbenchTranscriptNotifications } from "../../shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscript, type WorkbenchTranscriptProjection } from "../../shared/workbench/transcript/workbench-transcript-projection";
import OpenCodeServiceController from "../../daemon/server/providers/opencode/OpenCodeServiceController";
import IsolatedWorkbench from "./IsolatedWorkbench";
import {
  createProviderBoundaryJourney, PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE, PROVIDER_SHELL_PROOF_FILE,
  type ProviderBoundaryToolNames,
} from "./provider-boundary-journey";

const modelId = "opencode-go/muse-spark-1.3-contributor";
type Provider = "codex" | "opencode";
type ProjectedItems = WorkbenchTranscriptProjection["turns"][number]["items"];
type ProviderScenario = {
  initialPrompt?: string;
  tools: ProviderBoundaryToolNames;
  verifyFirstTurn?: (thread: ThreadPayload, id: string, title: string) => Promise<void>;
  verifySearch: (items: ProjectedItems) => void;
  verifyBinding?: (database: Database.Database, projectId: string, id: string) => void;
  verifyCapabilities?: () => Promise<void>;
  verifyNativeDeletion?: (id: string) => Promise<void>;
  verifyLegacyFiles?: () => Promise<void>;
};
const selectedProvider = process.env.WORKBENCH_THREAD_TEST_PROVIDER;

function passphrase() {
  const words = [
    "apple", "basket", "beach", "bird", "candle", "cherry", "cloud", "copper",
    "daisy", "drum", "fern", "forest", "garden", "grape", "horse", "island",
    "jacket", "kite", "lemon", "maple", "meadow", "moon", "ocean", "olive",
    "peach", "pencil", "rabbit", "river", "silver", "star", "tiger", "window",
  ];
  return Array.from({ length: 4 }, () => words.splice(randomInt(words.length), 1)[0]).join(" ");
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

async function prepareCodexFixture(runtime: IsolatedWorkbench, sourceDatabasePath: string, signal: AbortSignal) {
  const captured = await captureThreadStateMigrationSource(
    sourceDatabasePath, path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), { signal },
  );
  await verifyThreadStateMigrationSource(captured);
  await isolateThreadStateMigrationSource(captured, runtime.root, signal);
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
    "2. Call native exec_command with `node .workbench/transcript-gate.mjs && wb task get`. Do not use the Workbench shell tool.",
    "3. Wait for that command to finish. The scenario releases it. Do not bypass the gate.",
    "4. Call Workbench MCP task_get to read this task's title.",
    "5. Report the title and prefix proof together in commentary.",
    "6. Call Workbench MCP task_completed, then end with an empty final response. This completion is authorised.",
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
    await runtime.until(() => {
      healthy();
      return Boolean(current()?.turns.flatMap(turn => turn.items).some(item =>
        item.type === "commandExecution" && item.aggregatedOutput?.includes(gate.gateProof)));
    });
    const beforeSwitch = current()!.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "agentMessage").map(item => ({ id: item.id, text: item.text }));
    assert.ok(beforeSwitch.some(item => item.text.includes(prefixProof)), "Commentary must arrive before the held command");
    assert.ok(observed.texts > 0, "Incremental text must reach the real projection owner");
    assert.ok(!runtime.events.some(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId), "Resubscribe must occur during the live turn");
    const previousResets = observed.resets;
    const replacementSubscription = once(subscriptions, "settled", { signal });
    controller.select(null);
    controller.select({ thread: { ...thread, turns: [firstTurn] } });
    await replacementSubscription;
    await runtime.until(() => {
      healthy();
      return observed.resets > previousResets && current() !== null;
    });
    const restored = current()!.turns.flatMap(turn => turn.items);
    for (const earlier of beforeSwitch) {
      const item = restored.find(item => item.id === earlier.id);
      assert.deepEqual(item?.type === "agentMessage" ? { id: item.id, text: item.text } : null,
        earlier, "Resubscription must restore complete earlier commentary");
    }
    await fs.writeFile(gate.release, "");
    await runtime.until(() => runtime.events.some(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId));
    const completed = runtime.events.find(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn;
    assert.equal(completed.status, "completed", completed.error?.message ?? "Paid turn must complete");
    assert.ok(runtime.events.some(event => event.method === "item/agentMessage/delta"));
    await runtime.until(() => {
      healthy();
      return Boolean(current()?.turns.some(turn => turn.id === turnId && turn.status === "completed"));
    });
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
    assert.equal(read.thread.reasoningEffort, "low");
    const items = read.thread.turns.flatMap(turn => turn.items);
    assert.ok(items.some(item => item.type === "mcpToolCall" && item.tool === "task_completed" && item.status === "completed"));
    assert.ok(items.some(item => item.type === "commandExecution" && item.exitCode === 0));
    await controller.dispose();
    await runtime.stop();
    await runtime.start([profile], prefixProof);
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(reopened);
    assert.deepEqual(reopened.turns, snapshot.turns);
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, projection.data.turns);
    healthy();
  } finally {
    await fs.writeFile(gate.release, "");
    await controller.dispose();
  }
}

test("selected provider completes the shared thread boundary journey", {
  skip: selectedProvider !== "codex" && selectedProvider !== "opencode"
    ? "run with pnpm test:thread --codex --paid or --opencode --paid" : false,
}, async t => {
  const provider = selectedProvider as Provider;
  const now = Date.now();
  const prefixProof = passphrase();
  const openCodeProfile: WorkbenchComposerProfile = {
    id: randomUUID(),
    name: "opencode live scenario",
    description: "Explicit paid-model OpenCode provider diagnostic.",
    scope: { kind: "global" },
    harness: "opencode",
    model: modelId,
    reasoningEffort: null,
    serviceTier: null,
    agentPath: null,
    agentSource: null,
    createdAt: now,
    updatedAt: now,
  };
  const source = path.resolve(process.cwd(), "..");
  const openCodePaths = provider === "opencode" ? await Promise.all([
    IsolatedWorkbench.command("opencode", ["debug", "paths", "db"], source, process.env, t.signal),
    IsolatedWorkbench.command("opencode", ["debug", "paths", "config"], source, process.env, t.signal),
  ]) : null;
  const openCodeEnvironment = openCodePaths ? {
    ...process.env, OPENCODE_CONFIG_DIR: openCodePaths[1].trim(), OPENCODE_DB: openCodePaths[0].trim(),
  } : null;
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
  const profile = provider === "codex" ? await readCodexProfile() : openCodeProfile;
  const runtime = await IsolatedWorkbench.create(source, t.signal, {
    codexIdentity: provider === "codex",
    ...(openCodePaths ? { openCodeIdentity: {
      configDirectory: openCodePaths[1].trim(), database: openCodePaths[0].trim(),
    } } : {}),
  });
  let threadId: string | null = null;
  let nativeThreadId: string | null = null;
  let nativeSessionDeleted = false;
  let durableProjection: ReturnType<typeof projectWorkbenchTranscript> | null = null;
  let codexGate: Awaited<ReturnType<typeof prepareCodexFixture>> | null = null;
  let journeyGate: Awaited<ReturnType<typeof prepareJourneyGate>> | null = null;
  const activeProof = `active-${randomUUID()}`;
  const stopProof = `stop-${randomUUID()}`;
  const providerRegistry: Record<Provider, ProviderScenario> = {
    codex: {
      initialPrompt: codexFirstPrompt(),
      tools: {
        search: "Workbench MCP rg",
        shell: "Workbench MCP shell",
        taskGet: "Workbench MCP task_get",
        taskComplete: "Workbench MCP task_completed",
        questionnaire: "Workbench MCP request_user_input (NOT the native Codex questionnaire)",
      },
      verifyFirstTurn: async (thread: ThreadPayload, id: string, title: string) => {
        assert.ok(codexGate);
        await verifyCodexFirstTurn(runtime, thread, id, title, prefixProof, profile, codexGate, t.signal);
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
        await runtime.daemon.account.limits("codex");
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
        search: "the wb_rg tool",
        shell: "the wb_shell tool",
        taskGet: "the wb_task_get tool",
        taskComplete: "the wb_task_completed tool",
        questionnaire: "the wb_request_user_input tool",
      },
      verifySearch: (items: ProjectedItems) => {
        assert.ok(items.some(item => item.type === "dynamicToolCall"
          && item.tool === "execute" && item.status === "completed"
          && item.contentItems?.some(content => content.type === "inputText"
            && content.text.includes(PROVIDER_SEARCH_PROOF))),
        "OpenCode must complete WB search and preserve its result");
      },
      verifyNativeDeletion: async (id: string) => {
        assert.ok(openCodeEnvironment);
        const verificationService = new OpenCodeServiceController({
          environment: { ...openCodeEnvironment, WORKBENCH_DATA_ROOT: runtime.dataRootPath },
        });
        try {
          const verificationClient = await verificationService.acquire();
          await assert.rejects(verificationClient.session.get({ sessionID: id }),
            "The diagnostic must delete only its exact native OpenCode session");
        } finally { await verificationService.dispose(); }
      },
    },
  };
  try {
    if (provider === "codex") codexGate = await prepareCodexFixture(runtime, sourceDatabasePath, t.signal);
    journeyGate = await prepareJourneyGate(runtime);
    await runtime.start([profile], prefixProof);
    console.log(`[${provider} live] isolated runtime started`);
    await runtime.request("project/discovery-settings/update", { paths: [path.dirname(runtime.project)] });
    const catalog = await runtime.waitForProjects([runtime.project]);
    const project = catalog.find(entry => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(project, "Isolated project must be discoverable");
    const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens } = profile;
    const selection: WorkbenchComposerProfileTargetSelection = {
      kind: "profile", profileId: profile.id,
      settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier, contextWindowTokens },
    };
    await runtime.projectThreads(project.id);
    const journey = createProviderBoundaryJourney(providerRegistry[provider].tools, journeyGate.command);
    threadId = await runtime.launchDraft(project.id, selection,
      providerRegistry[provider].initialPrompt ?? journey.active(prefixProof, activeProof));
    const { thread } = await runtime.daemon.threads.page({ threadId, cursor: null });
    console.log(`[${provider} live] WB thread and native session created`);
    assert.equal(thread.harness, provider);
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    assert.equal(path.resolve(thread.cwd), runtime.project);
    const firstTurn = thread.turns.at(-1);
    assert.ok(firstTurn, "App draft launch must admit the first provider turn");
    const subscriptionId = `thread-${randomUUID()}`;
    const liveText = new Map<string, TranscriptTextUpdate>();
    const subscribe = () => runtime.transcripts.subscribe(
      { threadId: threadId!, turnLimit: 20, subscriptionId },
      () => {
        assert.fail("The thread scenario must use the incremental SQLite transcript protocol");
      },
      update => {
        if (update.kind !== "text" || update.field !== "agentMessageText") return;
        const previous = liveText.get(update.itemId);
        liveText.set(update.itemId, {
          ...update,
          text: update.append ? `${previous?.text ?? ""}${update.text}` : update.text,
        });
      },
    );
    const waitForFact = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
      for (;;) {
        const offset = runtime.events.length;
        const value = await read();
        if (ready(value)) return value;
        await runtime.until(() => runtime.events.slice(offset).some(event =>
          ["questionnaire/requested", "questionnaire/resolved", "turn/completed", "item/completed"]
            .includes(event.method ?? "")
          || event.method === workbenchTranscriptNotifications.streamed.method
          || event.method === "workspace/updated"));
      }
    };
    const durable = async () => {
      const snapshot = await waitForFact(
        () => runtime.transcripts.read({ threadId: threadId!, turnLimit: 30 }),
        value => value !== null,
      );
      assert.ok(snapshot, "The provider turn must be durable in SQLite");
      const projected = projectWorkbenchTranscript(snapshot);
      assert.ok(projected.success);
      return projected.data;
    };
    const waitHeldTool = async (id: string, proof: string) => {
      await waitForFact(durable, projection => {
        const turn = projection.turns.find(candidate => candidate.id === id);
        if (!turn) return false;
        const tool = turn.items.find(item =>
          ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(item.type)
          && JSON.stringify(item).includes(proof));
        if (tool) {
          assert.ok(tool.type === "commandExecution" || tool.type === "mcpToolCall"
            || tool.type === "dynamicToolCall");
          assert.equal(tool.status, "inProgress", "Shell gate settled before scenario released it");
          return true;
        }
        assert.ok(!turn.items.some(item =>
          (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
          && item.tool === "request_user_input" && item.status === "inProgress"),
        "Provider requested user input before starting the shell gate");
        assert.equal(turn.status, "inProgress", "Turn ended before starting the shell gate");
        return false;
      });
    };
    const steerProof = passphrase();
    const steerIntoActiveTurn = async (id: string) => {
      await waitHeldTool(id, activeProof);
      const result = await runtime.daemon.threads.message({
        threadId: threadId!, clientMessageId: randomUUID(), intent: "steer", expectedTurnId: id,
        input: [{ type: "text", text: journey.steer(steerProof), text_elements: [] }],
      });
      assert.deepEqual(result, { kind: "steered", turnId: id });
      assert.ok(journeyGate);
      await journeyGate.release(activeProof);
      return id;
    };
    if (provider === "opencode") await subscribe();
    let activeTurn = provider === "opencode" ? await steerIntoActiveTurn(firstTurn.id) : null;
    const title = `${provider} live ${randomUUID()}`;
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
    await providerRegistry[provider].verifyFirstTurn?.(thread, threadId, title);
    await providerRegistry[provider].verifyCapabilities?.();

    await fs.writeFile(path.join(runtime.project, PROVIDER_SEARCH_PROOF_FILE), PROVIDER_SEARCH_PROOF);
    if (provider === "codex") await subscribe();
    const submit = async (text: string, intent: "newTurn" | "continue" = "continue") => {
      const result = await runtime.daemon.threads.message({
        threadId: threadId!, clientMessageId: randomUUID(), intent,
        input: [{ type: "text", text, text_elements: [] }], context: { workflowIds: [] },
      });
      assert.equal(result.kind, "started");
      assert.ok(result.kind === "started");
      return result.turn.id;
    };
    const waitTurn = async (turnId: string, status: "completed" | "interrupted" = "completed") => {
      const value = await waitForFact(durable, projection => {
        const turn = projection.turns.find(candidate => candidate.id === turnId);
        if (turn && ["completed", "failed", "interrupted"].includes(turn.status) && turn.status !== status) {
          throw new Error(`${provider} turn ${turnId} settled as ${turn.status}; expected ${status}.`);
        }
        return turn?.status === status;
      });
      return value;
    };
    const readRetainedQuestions = async () => {
      const state = await runtime.projectThreads(project.id);
      return state.rows.flatMap(({ entry }) =>
        entry.entryKind !== "draft" && entry.pendingQuestionnaire ? [{
          ...entry.pendingQuestionnaire,
          ...entry.identity,
          itemId: entry.pendingQuestionnaire.itemId ?? null,
          turnId: entry.pendingQuestionnaire.turnId ?? null,
        }] : []);
    };
    const pending = async (id: string) => {
      let found: WorkbenchPendingUserInputRequest | undefined;
      const questions = await waitForFact(
        async () => (await runtime.daemon.questionnaires.pending()).data
          .filter(question => question.harness === provider && question.threadId === threadId),
        value => value.some(question => question.request.questions.some(entry => entry.id === id)),
      );
      found = questions.find(question => question.request.questions.some(entry => entry.id === id));
      return found as WorkbenchPendingUserInputRequest;
    };
    const answer = (question: WorkbenchPendingUserInputRequest, id: string, proof: string, supplementalInput?: string) =>
      runtime.daemon.threads.questionnaire.respond({
        projectId: project.id,
        threadId: threadId!,
        requestKey: question.requestKey,
        response: { answers: { [id]: { answers: [proof] } } },
        ...(supplementalInput ? {
          supplementalInput: [{ type: "text" as const, text: supplementalInput, text_elements: [] }],
        } : {}),
      });

    if (provider === "codex") activeTurn = await steerIntoActiveTurn(
      await submit(journey.active(prefixProof, activeProof)));
    assert.ok(activeTurn);
    const liveQuestion = await pending("live_answer");
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
    const liveProof = passphrase();
    assert.equal((await answer(liveQuestion, "live_answer", liveProof)).route, "live");
    const heldQuestion = await pending("held_answer");
    assert.equal(heldQuestion.turnId, activeTurn);
    assert.ok(JSON.stringify(await durable()).includes(liveProof));
    const liveHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    assert.ok(liveHistory.data.some(entry => entry.requestKey === liveQuestion.requestKey
      && entry.turnId === activeTurn && entry.response.answers.live_answer?.answers.includes(liveProof)));
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: heldQuestion.requestKey });
    await waitTurn(activeTurn, "interrupted");
    assert.ok((await readRetainedQuestions()).some(question => question.requestKey === heldQuestion.requestKey));

    await runtime.stop();
    await runtime.start([profile], prefixProof);
    await runtime.projectThreads(project.id);
    await subscribe();
    const retainedQuestions = await waitForFact(
      readRetainedQuestions,
      value => value.some(question => question.request.questions.some(entry => entry.id === "held_answer")),
    );
    const retainedQuestion = retainedQuestions.find(question =>
      question.request.questions.some(entry => entry.id === "held_answer"))!;
    const heldProof = passphrase();
    assert.equal((await answer(
      retainedQuestion,
      "held_answer",
      heldProof,
      journey.heldContinuation(prefixProof),
    )).route, "admitted");
    const heldHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    const heldEntry = heldHistory.data.find(entry => entry.requestKey === heldQuestion.requestKey);
    assert.ok(heldEntry && heldEntry.turnId !== activeTurn
      && heldEntry.response.answers.held_answer?.answers.includes(heldProof));
    const dismissQuestion = await pending("dismiss_preserved");
    const continuedProjection = await durable();
    assert.ok(JSON.stringify(continuedProjection).includes(heldProof));
    const continuedTurnId = dismissQuestion.turnId;
    assert.ok(continuedTurnId, "The retained question must identify its owning turn");
    assert.equal(continuedTurnId, heldEntry.turnId);
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: dismissQuestion.requestKey });
    const beforeDismiss = await waitTurn(continuedTurnId, "interrupted");
    await runtime.daemon.threads.stop({ threadId, intent: "stop", requestKey: dismissQuestion.requestKey });
    await waitForFact(durable, value => value.turns.every(turn => turn.status !== "inProgress"));
    await waitForFact(readRetainedQuestions, questions =>
      !questions.some(question => question.requestKey === dismissQuestion.requestKey));
    assert.deepEqual((await durable()).turns.map(turn => ({ id: turn.id, status: turn.status })),
      beforeDismiss.turns.map(turn => ({ id: turn.id, status: turn.status })),
      "Dismissing a preserved question must not create or interrupt a turn");

    const stoppedTurn = await submit(journey.stop(stopProof));
    await waitHeldTool(stoppedTurn, stopProof);
    await runtime.daemon.threads.stop({ threadId, intent: "stop", turnId: stoppedTurn });
    await journeyGate.release(stopProof);
    await waitTurn(stoppedTurn, "interrupted");
    if (provider === "codex") {
      await runtime.stop();
      await runtime.start([profile], prefixProof);
      await runtime.projectThreads(project.id);
      await subscribe();
    }
    const beforeCompact = await durable();
    const priorCompactions = new Set(beforeCompact.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "contextCompaction").map(item => item.id));
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

    const finalProof = passphrase();
    const finalTurn = await submit(journey.final(prefixProof, finalProof));
    durableProjection = { success: true, data: await waitTurn(finalTurn) };
    const finalItems = durableProjection.data.turns.find(turn => turn.id === finalTurn)?.items ?? [];
    assert.ok(JSON.stringify(finalItems).includes(finalProof));
    assert.ok(JSON.stringify(finalItems).includes(prefixProof));
    assert.ok(JSON.stringify(finalItems).includes(title));
    providerRegistry[provider].verifySearch(finalItems);
    const finalPage = await runtime.daemon.threads.page({ threadId, cursor: null });
    assert.equal(finalPage.thread.model, profile.model);
    assert.equal(finalPage.thread.reasoningEffort, profile.reasoningEffort);
    assert.equal(await fs.readFile(path.join(runtime.project, PROVIDER_SHELL_PROOF_FILE), "utf8"), finalProof);
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
    assert.ok([...liveText.values()].some(update => update.text.includes(prefixProof)),
      "The provider text stream must reach the shared live projection");
    await runtime.transcripts.unsubscribe({ subscriptionId });
    console.log(`[${provider} live] shared provider journey passed`);

    await runtime.stop();
    await runtime.start([profile], prefixProof);
    console.log(`[${provider} live] isolated runtime cold-reopened`);
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
  } catch (error) {
    console.error("thread scenario failed", error, "\napp tail\n", runtime.appOutput.slice(-12000),
      "\ndaemon tail\n", runtime.output.slice(-12000));
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
      await runtime.request("thread/provider/delete", { threadId }, {}, cleanup);
      assert.deepEqual(await runtime.transcripts.read({ threadId, turnLimit: 20 }), retained,
        "Provider deletion must retain WB transcript history");
    };
    try {
      if (codexGate) await fs.writeFile(codexGate.release, "");
      if (journeyGate) await Promise.all([journeyGate.release(activeProof), journeyGate.release(stopProof)]);
      await removeNativeSession();
    } finally {
      await runtime.close();
    }
  }
});

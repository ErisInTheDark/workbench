/*
 * No exports. Explicitly selected live test; ordinary discovery never spends provider usage.
 */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import WorkbenchComposerProfileStore from "../../daemon/server/WorkbenchComposerProfileStore";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "../../shared/database/workbench-database-statements";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import IsolatedWorkbench from "./IsolatedWorkbench";
import { captureThreadStateMigrationSource, installThreadStateMigrationSource, verifyThreadStateMigrationSource } from "./thread-state-migration-fixture";
import type { WorkbenchComposerProfile, WorkbenchProjectsPayload, WorkbenchPendingUserInputRequest } from "../../shared/types";
import type { ThreadPayload } from "../../shared/types";
import type { Turn } from "../../shared/workbench/thread/workbench-thread-turn";
import { workbenchTranscriptNotifications, type WorkbenchTranscriptSnapshot } from "../../shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscript } from "../../shared/workbench/transcript/workbench-transcript-projection";
import ThreadTranscriptProjectionController, { type ThreadTranscriptProjectionState } from "../../app/client/workbench/transcript/ThreadTranscriptProjectionController";
import type { WorkbenchTranscriptProjection } from "../../shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadItem } from "../../shared/workbench/thread/workbench-thread-items";
import type { WorkbenchThreadStateOpenResult } from "../../shared/workbench/thread/thread-state";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import {
  createProviderBoundaryJourney, PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE, PROVIDER_SHELL_PROOF_FILE,
} from "./provider-boundary-journey";

function passphrase() {
  const words = [
    "apple", "basket", "beach", "bird", "candle", "cherry", "cloud", "copper",
    "daisy", "drum", "fern", "forest", "garden", "grape", "horse", "island",
    "jacket", "kite", "lemon", "maple", "meadow", "moon", "ocean", "olive",
    "peach", "pencil", "rabbit", "river", "silver", "star", "tiger", "window",
  ];
  return Array.from({ length: 4 }, () => words.splice(randomInt(words.length), 1)[0]).join(" ");
}

test("current Workbench admits luna.low, preserves managed identity and records a real turn", {
  skip: process.env.WORKBENCH_CODEX_TEST_FILE !== "test/scenarios/codex.scenario.test.ts",
}, async (t) => {
  const source = path.resolve(process.cwd(), "..");
  const sourceDatabasePath = path.join(resolveWorkbenchDataRoot(), "daemon", "workbench.sqlite3");
  const sourceDatabase = new Database(sourceDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const profiles = new WorkbenchComposerProfileStore({
    query: async <Row extends WorkbenchDatabaseRow>(statement: Parameters<typeof compileWorkbenchDatabaseStatement>[1]) => {
      const compiled = compileWorkbenchDatabaseStatement(
        Object.fromEntries(workbenchDatabaseSchema.currentTables.map(table => [table.name, table])), statement,
      );
      return sourceDatabase.prepare(compiled.sql).all(...compiled.parameters) as Row[];
    },
    executeTransaction: async () => { throw new Error("Scenario source profiles are read-only."); },
  });
  let profile: WorkbenchComposerProfile | undefined;
  try { profile = (await profiles.read()).profiles.find(entry => entry.name === "luna.low"); }
  finally { await profiles.dispose(); sourceDatabase.close(); }
  assert.ok(profile?.harness === "codex" && profile.reasoningEffort === "low", "A stored luna.low Codex profile is required");
  const prefixProof = passphrase();
  const runtime = await IsolatedWorkbench.create(source, t.signal);
  console.log("isolated live fixture", runtime.root);
  let threadId: string | null = null;
  let nativeThreadId: string | null = null;
  let controller: ThreadTranscriptProjectionController | null = null;
  const release = path.join(runtime.project, ".workbench", "release-transcript-gate");
  const legacyRoot = path.join(runtime.project, ".workbench/transcripts/codex");
  const retainedFile = path.join(legacyRoot, "retained-cutover-evidence.json");
  const retainedContents = `{"retained":"${randomUUID()}"}`;
  try {
    const captured = await captureThreadStateMigrationSource(sourceDatabasePath, runtime.root);
    await verifyThreadStateMigrationSource(captured);
    await installThreadStateMigrationSource(
      captured,
      path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"),
      runtime.root,
    );
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(retainedFile, retainedContents);
    const gateProof = `gate-${randomUUID()}`;
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
    await runtime.start([profile], prefixProof);
    console.log("isolated daemon initialised");
    const catalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    const project = catalog.data.find((entry) => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(project, "Isolated project must be discoverable");
    const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } = profile;
    const selection = { kind: "profile", profileId: profile.id, settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } };
    await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
    await runtime.request("profiles/target/set", { slot: { kind: "new-thread", projectId: project.id }, selection });
    const started = { thread: await runtime.daemon.threads.create({
      projectId: project.id,
      context: { workflowIds: [] },
      profile: { kind: "target", slot: { kind: "new-thread", projectId: project.id } },
    }) };
    threadId = started.thread.id;
    console.log("scenario WB thread", threadId);
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    assert.equal(path.resolve(started.thread.cwd), runtime.project);
    const database = new Database(path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), { readonly: true });
    try {
      assert.deepEqual(database.pragma("foreign_key_check"), []);
      assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_projects'").get(), undefined);
      const owner = database.prepare(`
        SELECT thread.project_id, project.kind FROM workbench_threads AS thread
        JOIN workbench_projects AS project ON project.id = thread.project_id WHERE thread.id = ?
      `).get(threadId);
      assert.deepEqual(owner, { project_id: project.id, kind: "git" }, "New provider admission must use the migrated project owner");
      const native = database.prepare("SELECT native_thread_id FROM workbench_pending_import_threads WHERE thread_id = ?").get(threadId) as { native_thread_id: string } | undefined;
      assert.ok(native, "Public thread must own a private provider binding immediately after creation");
      nativeThreadId = native.native_thread_id;
      assert.notEqual(threadId, nativeThreadId);
    } finally { database.close(); }
    const title = `live scenario ${passphrase()}`;
    await runtime.daemon.threads.title({ threadId, title });
    const cli = await IsolatedWorkbench.command("bash", [
      path.join(runtime.project, "daemon/node_modules/.bin/wb"), "task", "get",
    ], runtime.project, {
      ...process.env,
      WORKBENCH_DATA_ROOT: runtime.dataRootPath,
      WORKBENCH_THREAD_ID: threadId,
      CODEX_THREAD_ID: nativeThreadId,
    }, t.signal);
    assert.ok(cli.includes(title), "CLI must resolve its managed WB caller identity");
    const errors: Error[] = [];
    const subscriptions = new EventEmitter();
    const observed = { state: { status: "idle" } as ThreadTranscriptProjectionState, resets: 0, texts: 0 };
    const current = (): WorkbenchTranscriptProjection | null => (
      observed.state.status === "ready" ? observed.state.projection : null
    );
    let transcriptSelection = {
      thread: started.thread,
    };
    controller = new ThreadTranscriptProjectionController({
      available: true, turnLimit: 10,
      onError: error => errors.push(error),
      onStateChange: state => { observed.state = state; },
      onText: () => { observed.texts++; },
      transcripts: {
        unsubscribe: params => runtime.transcripts.unsubscribe(params),
        subscribe: async (params, _legacy, stream) => {
          try {
            await runtime.transcripts.subscribe(params, () => {
              errors.push(new Error("Live scenario received a legacy transcript snapshot"));
            }, update => {
              if (update.kind === "structure" && update.reset) observed.resets++;
              stream?.(update);
            });
          } finally {
            subscriptions.emit("settled");
          }
        },
      },
    });
    const initialSubscription = once(subscriptions, "settled", { signal: t.signal });
    controller.select(transcriptSelection);
    await initialSubscription;
    const healthy = () => { assert.deepEqual(errors, [], "Projection errors must fail the scenario"); };
    const prompt = [
      "This is an authorised Workbench scenario. Follow these steps exactly, in order.",
      "1. Report the prefix proof from project instructions in commentary.",
      "2. Call Workbench MCP task_get to read this task's title.",
      "3. Call native exec_command with `wb task get && node .workbench/transcript-gate.mjs`. Do not use the Workbench shell tool.",
      "4. Wait for that command to finish. The scenario releases it. Do not bypass the gate.",
      "5. Report the title and prefix proof together in commentary.",
      "6. Call Workbench MCP task_completed, then end with an empty final response. This completion is authorised.",
      "Do not edit files, spawn agents, ask questions or make plans.",
    ].join("\n");
    console.log("starting paid luna.low turn");
    const response = await runtime.daemon.threads.message({
      threadId, clientMessageId: randomUUID(), intent: "newTurn",
      input: [{ type: "text", text: prompt, text_elements: [] }],
      context: { workflowIds: [] },
    });
    assert.equal(response.kind, "started");
    assert.ok(response.kind === "started");
    const turnId = response.turn.id;
    // Match the app's admitted turn selection; an empty exact window excludes this turn.
    transcriptSelection = { ...transcriptSelection, thread: { ...started.thread, turns: [response.turn] } };
    controller.select(transcriptSelection);
    await runtime.until(() => {
      healthy();
      return Boolean(current()?.turns.flatMap(turn => turn.items).some(item => (
        item.type === "commandExecution" && item.aggregatedOutput?.includes(gateProof)
      )));
    });
    const beforeSwitch = current()!.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "agentMessage").map(item => ({ id: item.id, text: item.text }));
    assert.ok(beforeSwitch.some(item => item.text.includes(prefixProof)), "Commentary must arrive before the held command");
    assert.ok(observed.texts > 0, "Incremental text must reach the real projection owner");
    assert.ok(!runtime.events.some(event => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId), "Resubscribe must occur during the live turn");
    const previousResets = observed.resets;
    // Subscribe acknowledgement follows both structural baseline and live-field replay.
    const replacementSubscription = once(subscriptions, "settled", { signal: t.signal });
    controller.select(null);
    controller.select(transcriptSelection);
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
    await fs.writeFile(release, "");
    await runtime.until(() => runtime.events.some((event) => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId));
    const completed = runtime.events.find((event) => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn;
    assert.equal(completed.status, "completed", completed.error?.message ?? "Paid turn must complete");
    assert.ok(runtime.events.some((event) => event.method === "item/agentMessage/delta"), "Live text deltas must reach the client");
    await runtime.until(() => {
      healthy();
      return Boolean(current()?.turns.some(turn => turn.id === turnId && turn.status === "completed"));
    });
    const snapshot: WorkbenchTranscriptSnapshot | null = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(snapshot, "Completed thread must have a durable transcript before any historical page read");
    assert.equal(snapshot.thread.id, threadId);
    assert.ok(snapshot.turns.some((turn) => turn.id === turnId && turn.state === "completed"));
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success, "The app's SQLite projector must accept the recorded transcript");
    assert.deepEqual(current()!.turns.map(turn => ({ id: turn.id, items: turn.items })),
      projection.data.turns.map(turn => ({ id: turn.id, items: turn.items })),
      "Live client item identities, order and content must match durable SQL before historical reads");
    assert.ok(projection.data.turns.flatMap((turn) => turn.items).some((item) => (
      item.type === "agentMessage" && item.text.includes(prefixProof) && item.text.includes(title)
    )), "SQLite must independently preserve the agent's instruction and identity proof");
    const read = await runtime.daemon.threads.page({ threadId, cursor: null });
    assert.equal(read.thread.id, threadId);
    assert.equal(read.thread.model, profile.model, "Daemon admission must use the stored model without browser-native settings");
    assert.equal(read.thread.reasoningEffort, "low", "Daemon admission must use the stored effort");
    const items = read.thread.turns.flatMap((turn) => turn.items);
    const answer = items.filter((item) => item.type === "agentMessage").map((item) => item.text).join("\n");
    assert.ok(answer.includes(prefixProof), "Project instructions must survive admission");
    assert.ok(answer.includes(title), "Agent must successfully use its managed tool identity");
    assert.ok(items.some((item) => item.type === "mcpToolCall" && item.status === "completed"), "A real MCP call must complete");
    assert.ok(items.some((item) => item.type === "mcpToolCall" && item.tool === "task_completed" && item.status === "completed"), "The agent must finish through Workbench's managed completion gate");
    assert.ok(items.some((item) => item.type === "commandExecution" && item.exitCode === 0), "A real agent CLI command must complete");
    await controller.dispose();
    controller = null;
    await runtime.stop();
    await runtime.start([profile], prefixProof);
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(reopened, "Transcript must survive a cold restart");
    assert.deepEqual(reopened.turns, snapshot.turns);
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, projection.data.turns, "Cold reopening must preserve all visible turn items");
    console.log("fresh admission, live projection and immediate cold SQL read passed");

    const watchTranscript = () => runtime.transcripts.subscribe({
      threadId: threadId!, turnLimit: 20, subscriptionId: "boundary-journey",
    }, () => {
      errors.push(new Error("The boundary journey must use the incremental SQL protocol"));
    }, () => {
      // IsolatedWorkbench's notification observer wakes the durable-fact checks.
    });
    await watchTranscript();
    // Read durable facts only after notifications advance, never on a sleep/poll loop.
    const waitForFact = async <T>(readFact: () => Promise<T>, ready: (fact: T) => boolean): Promise<T> => {
      for (;;) {
        healthy();
        const offset = runtime.events.length;
        const fact = await readFact();
        if (ready(fact)) return fact;
        await runtime.until(() => runtime.events.slice(offset).some(event =>
          ["questionnaire/requested", "questionnaire/resolved",
            "turn/completed", "item/completed"].includes(event.method ?? "")
          || event.method === "workbench/thread-state/updated"
          || event.method === workbenchTranscriptNotifications.streamed.method
            && (event.params?.update as { kind?: string } | undefined)?.kind === "structure"));
      }
    };
    const durable = async () => {
      const snapshot = await waitForFact(
        () => runtime.transcripts.read({ threadId: threadId!, turnLimit: 20 }),
        snapshot => snapshot !== null,
      );
      assert.ok(snapshot);
      const result = projectWorkbenchTranscript(snapshot);
      assert.ok(result.success);
      return result.data;
    };
    const itemsFor = (value: WorkbenchTranscriptProjection, id: string) =>
      value.turns.find(turn => turn.id === id)?.items ?? [];
    const hasText = (items: WorkbenchTranscriptProjection["turns"][number]["items"], proof: string) => items.some(item =>
      item.type === "agentMessage" && item.text.includes(proof));
    const eventItems = (method: string, id: string) => runtime.events
      .filter(event => event.method === method && event.params?.threadId === threadId && event.params?.turnId === id)
      .map(event => event.params?.item as ThreadItem);
    const waitTurn = async (id: string, status: Turn["status"]) => {
      await runtime.until(() => runtime.events.some(event => event.method === "turn/completed"
        && event.params?.threadId === threadId && (event.params?.turn as Turn | undefined)?.id === id));
      const value = await waitForFact(durable, value => value.turns.some(turn => turn.id === id && turn.status !== "inProgress"));
      assert.equal(value.turns.find(turn => turn.id === id)?.status, status);
      return value;
    };
    const submit = async (text: string) => {
      const result = await runtime.daemon.threads.message({
        threadId: threadId!, clientMessageId: randomUUID(), intent: "continue",
        input: [{ type: "text", text, text_elements: [] }], context: { workflowIds: [] },
      });
      assert.equal(result.kind, "started");
      assert.ok(result.kind === "started");
      return result.turn.id;
    };
    const readQuestions = async () => {
      const state = await runtime.request<WorkbenchThreadStateOpenResult>("workbench/thread-state/open", {
        projectId: project.id, version: 4,
      });
      return { data: state.sidebar.entries.flatMap(entry =>
        entry.entryKind === "thread" && entry.pendingQuestionnaire
          ? [{
            ...entry.pendingQuestionnaire, ...entry.identity,
            itemId: entry.pendingQuestionnaire.itemId ?? null,
            turnId: entry.pendingQuestionnaire.turnId ?? null,
          }]
          : []) };
    };
    const pending = async (questionId: string, expectedTurn: string) => {
      const result = await waitForFact(readQuestions,
        result => {
          const found = result.data.some(question => question.threadId === threadId
            && question.request.questions.some(question => question.id === questionId));
          assert.ok(found || !runtime.events.some(event => event.method === "turn/completed"
            && (event.params?.turn as Turn | undefined)?.id === expectedTurn),
          `Turn ended before asking ${questionId}`);
          return found;
        });
      return result.data.find(question => question.threadId === threadId
        && question.request.questions.some(question => question.id === questionId))!;
    };
    const answerQuestion = async (question: WorkbenchPendingUserInputRequest, proof: string, instructions?: string) =>
      runtime.daemon.threads.questionnaire.respond({
        projectId: project.id, threadId: threadId!, requestKey: question.requestKey,
        response: { answers: { [question.request.questions[0].id]: { answers: [proof] } } },
        ...(instructions ? { supplementalInput: [{ type: "text" as const, text: instructions, text_elements: [] }] } : {}),
      });
    await fs.writeFile(path.join(runtime.project, PROVIDER_SEARCH_PROOF_FILE), PROVIDER_SEARCH_PROOF);
    const journey = createProviderBoundaryJourney({
      search: "Workbench MCP rg",
      shell: "Workbench MCP shell",
      taskGet: "Workbench MCP task_get",
      taskComplete: "Workbench MCP task_completed",
      questionnaire: "Workbench MCP request_user_input (NOT the native Codex questionnaire)",
    });
    const waitSleep = async (id: string, proof: string) => {
      await runtime.until(() => {
        const started = eventItems("item/started", id)
          .some(item => (item.type === "commandExecution" || item.type === "mcpToolCall")
            && JSON.stringify(item).includes(proof));
        assert.ok(started || !runtime.events.some(event => event.method === "turn/completed"
          && (event.params?.turn as Turn | undefined)?.id === id), "Turn ended before the requested sleep");
        return started;
      });
      assert.ok(!eventItems("item/completed", id).some(item =>
        (item.type === "commandExecution" || item.type === "mcpToolCall")
        && JSON.stringify(item).includes(proof)), "The action must arrive while the sleep is active");
    };
    const restart = async () => {
      await runtime.stop();
      await runtime.start([profile], prefixProof);
      await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
      await watchTranscript();
    };
    await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
    assert.ok((await runtime.daemon.models.list("codex")).data.some(entry => entry.id === profile.model));
    await runtime.daemon.account.limits("codex");

    const sleepProof = passphrase();
    const steerProof = passphrase();
    const existingTurn = await submit(journey.active(prefixProof, sleepProof));
    await waitSleep(existingTurn, sleepProof);
    const steer = await runtime.daemon.threads.message({
      threadId, clientMessageId: randomUUID(), intent: "steer", expectedTurnId: existingTurn,
      input: [{ type: "text", text: journey.steer(steerProof), text_elements: [] }],
    });
    assert.equal(steer.kind, "steered");
    assert.ok(steer.kind === "steered" && steer.turnId === existingTurn);
    const liveQuestion = await pending("live_answer", existingTurn);
    const steered = await durable();
    const steeredItems = itemsFor(steered, existingTurn);
    assert.ok(hasText(steeredItems, prefixProof), "Existing-thread admission must retain managed instructions");
    assert.ok(hasText(steeredItems, steerProof), "The agent must receive the steer, not merely acknowledge admission");
    const sleepIndex = steeredItems.findIndex(item =>
      (item.type === "commandExecution" || item.type === "mcpToolCall")
      && JSON.stringify(item).includes(sleepProof));
    const steerIndex = steeredItems.findIndex(item => item.type === "userMessage"
      && item.content.some(content => content.type === "text" && content.text.includes(steerProof)));
    assert.ok(sleepIndex >= 0 && steerIndex > sleepIndex, "Delivered steer must follow the sleep in transcript order");
    assert.ok(JSON.stringify(steeredItems[sleepIndex]).includes(sleepProof));
    assert.equal(liveQuestion.turnId, existingTurn);
    assert.ok((await runtime.daemon.questionnaires.pending()).data
      .some(question => question.requestKey === liveQuestion.requestKey), "The active waiter must also be available for live delivery");
    console.log("existing-thread admission and post-sleep steer delivery passed");
    const liveProof = passphrase();
    assert.equal((await answerQuestion(liveQuestion, liveProof)).route, "live");
    const heldQuestion = await pending("held_answer", existingTurn);
    const liveHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    assert.ok(liveHistory.data.some(entry => entry.requestKey === liveQuestion.requestKey
      && entry.turnId === existingTurn && entry.response.answers.live_answer?.answers.includes(liveProof)));
    assert.ok(hasText(itemsFor(await durable(), existingTurn), liveProof));
    console.log("live questionnaire delivery and durable answer passed");
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: heldQuestion.requestKey });
    await waitTurn(existingTurn, "interrupted");
    assert.ok((await readQuestions()).data.some(question => question.requestKey === heldQuestion.requestKey),
      "Snooze must preserve the questionnaire before acknowledging success");
    await restart();
    const retained = (await readQuestions()).data.find(question => question.requestKey === heldQuestion.requestKey);
    assert.ok(retained, "The held questionnaire must be available immediately after restart");
    const heldProof = passphrase();
    assert.equal((await answerQuestion(retained, heldProof, journey.heldContinuation(prefixProof))).route, "admitted");
    const heldHistory = await runtime.daemon.threads.history.questionnaires({ threadId });
    const heldEntry = heldHistory.data.find(entry => entry.requestKey === heldQuestion.requestKey);
    assert.ok(heldEntry && heldEntry.turnId !== existingTurn
      && heldEntry.response.answers.held_answer?.answers.includes(heldProof));
    const continuationTurn = heldEntry.turnId;
    const dismissQuestion = await pending("dismiss_preserved", continuationTurn);
    assert.equal(dismissQuestion.turnId, continuationTurn);
    const continuedItems = itemsFor(await durable(), continuationTurn);
    assert.ok(hasText(continuedItems, heldProof) && hasText(continuedItems, prefixProof));
    console.log("snooze, cold held-answer admission and durable answer passed");
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: dismissQuestion.requestKey });
    const beforeDismiss = await waitTurn(continuationTurn, "interrupted");
    await runtime.daemon.threads.stop({ threadId, intent: "stop", requestKey: dismissQuestion.requestKey });
    assert.ok(!(await readQuestions()).data.some(question => question.threadId === threadId));
    assert.ok(!(await runtime.daemon.questionnaires.pending()).data.some(question => question.threadId === threadId));
    assert.deepEqual((await durable()).turns.map(turn => ({ id: turn.id, status: turn.status })),
      beforeDismiss.turns.map(turn => ({ id: turn.id, status: turn.status })),
      "Dismissing a preserved question must not create or interrupt a turn");
    console.log("existing admission, active steer, live/held answers, snooze and preserved dismissal passed");

    const stopProof = passphrase();
    const stoppedTurn = await submit(journey.stop(stopProof));
    await waitSleep(stoppedTurn, stopProof);
    await runtime.daemon.threads.stop({ threadId, intent: "stop", turnId: stoppedTurn });
    await waitTurn(stoppedTurn, "interrupted");
    await restart();
    const beforeCompact = await durable();
    const priorCompactions = new Set(beforeCompact.turns.flatMap(turn => turn.items)
      .filter(item => item.type === "contextCompaction").map(item => item.id));
    await runtime.daemon.threads.compact({ threadId });
    const compacted = await waitForFact(durable, value => value.turns.flatMap(turn => turn.items)
      .some(item => item.type === "contextCompaction" && !priorCompactions.has(item.id))
      && value.turns.every(turn => turn.status !== "inProgress"));
    assert.deepEqual(compacted.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage"),
      beforeCompact.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage"),
      "Compaction must not inject a new user message or ordinary admission turn");
    const finalProof = passphrase();
    const finalTurn = await submit(journey.final(prefixProof, finalProof));
    const finalProjection = await waitTurn(finalTurn, "completed");
    const finalItems = itemsFor(finalProjection, finalTurn);
    assert.ok(hasText(finalItems, finalProof) && hasText(finalItems, prefixProof) && hasText(finalItems, title));
    assert.ok(finalItems.some(item => item.type === "mcpToolCall"
      && item.tool === "rg" && item.status === "completed"), "Codex must complete WB search");
    assert.ok(finalItems.some(item => item.type === "mcpToolCall" && item.tool === "task_completed" && item.status === "completed"));
    assert.equal(await fs.readFile(path.join(runtime.project, PROVIDER_SHELL_PROOF_FILE), "utf8"), finalProof);
    const finalPage = await runtime.daemon.threads.page({ threadId, cursor: null });
    assert.equal(finalPage.thread.model, profile.model);
    assert.equal(finalPage.thread.reasoningEffort, profile.reasoningEffort);
    await restart();
    assert.deepEqual((await durable()).turns, finalProjection.turns, "The complete scenario journey must survive cold reopening");
    console.log("active stop, cold compaction and post-compaction admission passed");
    healthy();
    assert.equal(await fs.readFile(retainedFile, "utf8"), retainedContents, "Cutover must preserve retained legacy files");
    assert.deepEqual((await fs.readdir(legacyRoot, { recursive: true })).filter(file => /\.(?:json|jsonl|ndjson)$/u.test(file)),
      [path.basename(retainedFile)], "Live recording and cold reopen must not create JSON transcript files");
    console.log("live admission, CLI/MCP and transcript checks passed");
  } catch (error) {
    console.error("live scenario failed", error, "\napp tail\n", runtime.appOutput.slice(-12000),
      "\ndaemon tail\n", runtime.output.slice(-12000));
    throw error;
  } finally {
    try {
      await fs.writeFile(release, "");
      await controller?.dispose();
      if (threadId && nativeThreadId) {
        // Separate cleanup budget survives the paid-turn deadline. Only the exact
        // response-created thread is eligible; no search, inferred ID or user input.
        const cleanup = AbortSignal.timeout(45_000);
        const current = await runtime.request<ThreadPayload>("thread/metadata/read", { threadId }, {}, cleanup);
        assert.equal(current.id, threadId);
        assert.equal(path.resolve(current.cwd), runtime.project);
        const retained = await runtime.transcripts.read({ threadId, turnLimit: 20 });
        await runtime.request("thread/provider/delete", { threadId }, {}, cleanup);
        await assert.rejects(runtime.request("thread/metadata/read", { threadId }, {}, cleanup), /thread not loaded|not found|unavailable/iu);
        assert.deepEqual(await runtime.transcripts.read({ threadId, turnLimit: 20 }), retained, "Provider deletion must retain WB transcript history");
        await runtime.request("project/catalog/read", {}, {}, cleanup);
        console.log("deleted exact test-created Codex thread");
      }
    } finally { await runtime.close(); }
  }
});

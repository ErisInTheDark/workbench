/*
 * No exports. Explicitly selected live test; ordinary discovery never spends provider usage.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import IsolatedWorkbench from "./IsolatedWorkbench";
import { captureThreadStateMigrationSource, installThreadStateMigrationSource, verifyThreadStateMigrationSource } from "./thread-state-migration-fixture";
import type { WorkbenchComposerProfile, WorkbenchProjectsPayload } from "../shared/types";
import type { Thread } from "../shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "../shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchTranscriptSnapshot } from "../shared/workbench/database/transcript/workbench-transcript-contract";
import { WORKBENCH_THREAD_PAGE_READ_METHOD, type WorkbenchThreadPageResponse } from "../shared/workbench/thread/workbench-thread-page";
import { projectWorkbenchTranscript } from "../shared/workbench/transcript/workbench-transcript-projection";
import { toThreadPayload } from "../shared/codex/thread-adapter";
import { WorkbenchThreadIdSchema } from "../shared/workbench/identity";
import ThreadTranscriptProjectionController, { type ThreadTranscriptProjectionState } from "../app/client/workbench/transcript/ThreadTranscriptProjectionController";
import type { WorkbenchTranscriptProjection } from "../shared/workbench/transcript/workbench-transcript-projection";

test("current Workbench admits luna.low, preserves managed identity and records a real turn", {
  skip: process.env.WORKBENCH_CODEX_TEST_FILE !== "diagnostics/workbench-codex.test.ts",
  timeout: 600_000,
}, async (t) => {
  const source = path.resolve(process.cwd(), "..");
  const profiles = JSON.parse(await fs.readFile(path.join(source, ".workbench/runtime/composer-profiles.json"), "utf8")) as {
    version: number; profiles: Record<string, WorkbenchComposerProfile>;
  };
  const profile = Object.values(profiles.profiles).find((entry) => entry.name === "luna.low");
  assert.ok(profile?.harness === "codex" && profile.reasoningEffort === "low", "A stored luna.low Codex profile is required");
  const prefixProof = `prefix-${randomUUID()}`;
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
    const captured = await captureThreadStateMigrationSource(source, runtime.root);
    await verifyThreadStateMigrationSource(captured);
    await installThreadStateMigrationSource(captured, runtime.project, runtime.root);
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
    await runtime.start({ version: profiles.version, profiles: { [profile.id]: profile } }, prefixProof);
    console.log("isolated daemon initialised");
    const catalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    const project = catalog.data.find((entry) => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(project, "Isolated project must be discoverable");
    const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } = profile;
    const selection = { kind: "profile", profileId: profile.id, settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } };
    await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
    await runtime.request("profiles/target/set", { slot: { kind: "new-thread", projectId: project.id }, selection });
    const context = { cwd: runtime.project, projectId: project.id, roots: project.roots, agentPath: null, workflowIds: [], threadId: null };
    const started = await runtime.request<{ thread: Thread }>("thread/start", {
      cwd: runtime.project, model: profile.model, ephemeral: false,
      approvalPolicy: "never", sandbox: "workspace-write",
    }, {
      workbenchPromptContext: context,
      workbenchCreationProfile: { kind: "target", slot: { kind: "new-thread", projectId: project.id } },
    });
    threadId = started.thread.id;
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    assert.equal(path.resolve(started.thread.cwd), runtime.project);
    const database = new Database(path.join(runtime.project, ".workbench/workbench.sqlite3"), { readonly: true });
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
    const title = `live diagnostic ${randomUUID()}`;
    await runtime.request("thread/name/set", { threadId, name: title });
    const cli = await IsolatedWorkbench.command("bash", [
      path.join(runtime.project, "daemon/node_modules/.bin/wb"), "task", "get",
    ], runtime.project, { ...process.env, WORKBENCH_THREAD_ID: threadId, CODEX_THREAD_ID: nativeThreadId }, t.signal);
    assert.ok(cli.includes(title), "CLI must resolve its managed WB caller identity");
    const errors: Error[] = [];
    const subscriptions = new EventEmitter();
    const observed = { state: { status: "idle" } as ThreadTranscriptProjectionState, resets: 0, texts: 0 };
    const current = (): WorkbenchTranscriptProjection | null => (
      observed.state.status === "ready" ? observed.state.projection : null
    );
    let transcriptSelection = {
      thread: toThreadPayload({ ...started.thread, id: WorkbenchThreadIdSchema.parse(threadId) }),
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
              errors.push(new Error("Live diagnostic received a legacy transcript snapshot"));
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
    const healthy = () => { assert.deepEqual(errors, [], "Projection errors must fail the diagnostic"); };
    const prompt = "This is an authorised Workbench diagnostic. First report the prefix proof required by project instructions in commentary. Use the Workbench MCP task_get tool to read this task's title. Then run `wb task get && node .workbench/transcript-gate.mjs` through Codex's native exec_command shell tool, not the Workbench MCP shell tool. The diagnostic releases that command after checking live transcript resubscription. Wait for it to finish, without changing or bypassing the gate. Do not edit files, spawn agents, ask questions, or create plans. Report the title and prefix proof in commentary again after the command completes. After both title checks succeed, call the Workbench task_completed tool for this diagnostic thread, then finish with an empty final response. That completion is authorised and required so Workbench does not automatically resume unfinished work.";
    console.log("starting paid luna.low turn");
    const response = await runtime.request<{ turn: Turn }>("turn/start", {
      threadId, cwd: runtime.project, input: [{ type: "text", text: prompt, text_elements: [] }],
      model: "stale-client-model", effort: "high",
    }, { workbenchPromptContext: { ...context, threadId } });
    const turnId = response.turn.id;
    // Match the app's admitted turn selection; an empty exact window excludes this turn.
    transcriptSelection = { ...transcriptSelection, thread: toThreadPayload({
      ...started.thread, id: WorkbenchThreadIdSchema.parse(threadId), turns: [response.turn],
    }) };
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
    const read = await runtime.request<WorkbenchThreadPageResponse>(WORKBENCH_THREAD_PAGE_READ_METHOD, { threadId, cursor: null, cwd: runtime.project });
    assert.equal(read.thread.id, threadId);
    assert.equal(read.thread.model, profile.model, "The stored profile must replace stale client model settings");
    assert.equal(read.thread.reasoningEffort, "low", "The stored profile must replace stale client effort");
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
    await runtime.start({ version: profiles.version, profiles: { [profile.id]: profile } }, prefixProof);
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(reopened, "Transcript must survive a cold restart");
    assert.deepEqual(reopened.turns, snapshot.turns);
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, projection.data.turns, "Cold reopening must preserve all visible turn items");
    healthy();
    assert.equal(await fs.readFile(retainedFile, "utf8"), retainedContents, "Cutover must preserve retained legacy files");
    assert.deepEqual((await fs.readdir(legacyRoot, { recursive: true })).filter(file => /\.(?:json|jsonl|ndjson)$/u.test(file)),
      [path.basename(retainedFile)], "Live recording and cold reopen must not create JSON transcript files");
    console.log("live admission, CLI/MCP and transcript checks passed");
  } catch (error) {
    console.error("live diagnostic failed", error);
    throw error;
  } finally {
    try {
      await fs.writeFile(release, "");
      await controller?.dispose();
      if (threadId && nativeThreadId) {
        // Separate cleanup budget survives the paid-turn deadline. Only the exact
        // response-created thread is eligible; no search, inferred ID or user input.
        const cleanup = AbortSignal.timeout(45_000);
        const current = await runtime.request<{ thread: Thread }>("thread/read", { threadId, includeTurns: false }, {}, cleanup);
        assert.equal(current.thread.id, threadId);
        assert.equal(path.resolve(current.thread.cwd), runtime.project);
        await runtime.request("thread/delete", { threadId }, {}, cleanup);
        await assert.rejects(runtime.request("thread/read", { threadId, includeTurns: false }, {}, cleanup), /thread not loaded|not found/iu);
        await runtime.request("project/catalog/read", {}, {}, cleanup);
        console.log("deleted exact test-created Codex thread");
      }
    } finally { await runtime.close(); }
  }
});

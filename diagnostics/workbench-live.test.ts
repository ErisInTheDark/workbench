/*
 * Keywords: paid Codex, luna low, startup, profile, instructions, transcript, managed identity, cleanup.
 * No exports. Explicitly selected live test; ordinary discovery never spends provider usage.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import IsolatedWorkbench from "./IsolatedWorkbench";
import type { WorkbenchComposerProfile, WorkbenchProjectsPayload } from "../shared/types";
import type { Thread } from "../shared/codex/generated/app-server/v2/Thread";
import type { Turn } from "../shared/codex/generated/app-server/v2/Turn";
import type { WorkbenchTranscriptSnapshot } from "../shared/workbench/database/transcript/workbench-transcript-contract";
import { WORKBENCH_THREAD_PAGE_READ_METHOD, type WorkbenchThreadPageResponse } from "../shared/workbench/thread/workbench-thread-page";
import { projectWorkbenchTranscript } from "../shared/workbench/transcript/workbench-transcript-projection";

test("current Workbench admits luna.low, preserves managed identity and records a real turn", {
  skip: process.env.WORKBENCH_LIVE_TEST_FILE !== "diagnostics/workbench-live.test.ts",
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
  try {
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
    }, { workbenchPromptContext: context });
    threadId = started.thread.id;
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    assert.equal(path.resolve(started.thread.cwd), runtime.project);
    const database = new Database(path.join(runtime.project, ".workbench/workbench.sqlite3"), { readonly: true });
    try {
      const native = database.prepare("SELECT native_thread_id FROM workbench_pending_import_threads WHERE thread_id = ?").get(threadId) as { native_thread_id: string } | undefined;
      assert.ok(native, "Public thread must own a private provider binding immediately after creation");
      nativeThreadId = native.native_thread_id;
      assert.notEqual(threadId, nativeThreadId);
    } finally { database.close(); }
    const title = `live diagnostic ${randomUUID()}`;
    await runtime.request("thread/name/set", { threadId, name: title });
    const cli = await IsolatedWorkbench.command("bash", [
      path.join(runtime.project, "daemon/node_modules/.bin/wb"), "thread", "title", "get",
    ], runtime.project, { ...process.env, WORKBENCH_THREAD_ID: threadId, CODEX_THREAD_ID: nativeThreadId }, t.signal);
    assert.ok(cli.includes(title), "CLI must resolve its managed WB caller identity");
    const snapshots: WorkbenchTranscriptSnapshot[] = [];
    const subscriptionId = randomUUID();
    await runtime.transcripts.subscribe({ subscriptionId, threadId, turnLimit: 10 }, (snapshot) => {
      if (snapshot) snapshots.push(snapshot);
    });
    const prompt = "This is an authorised Workbench diagnostic. Use the Workbench MCP thread_title_get tool to read this thread's title. Then run `wb thread title get` through Codex's native exec_command shell tool, not the Workbench MCP shell tool. Do not edit files, spawn agents, ask questions, or create plans. Report the title and the prefix proof required by project instructions in commentary. After both title checks succeed, call the Workbench thread_status tool with status completed for this diagnostic thread, then finish with an empty final response. That status change is authorised and required so Workbench does not automatically resume unfinished work.";
    console.log("starting paid luna.low turn");
    const response = await runtime.request<{ turn: Turn }>("turn/start", {
      threadId, cwd: runtime.project, input: [{ type: "text", text: prompt, text_elements: [] }],
      model: "stale-client-model", effort: "high",
    }, { workbenchPromptContext: { ...context, threadId } });
    const turnId = response.turn.id;
    await runtime.until(() => runtime.events.some((event) => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId));
    const completed = runtime.events.find((event) => event.method === "turn/completed"
      && (event.params?.turn as Turn | undefined)?.id === turnId)?.params?.turn as Turn;
    assert.equal(completed.status, "completed", completed.error?.message ?? "Paid turn must complete");
    assert.ok(runtime.events.some((event) => event.method === "item/agentMessage/delta"), "Live text deltas must reach the client");
    await runtime.until(() => snapshots.some((snapshot) => snapshot.turns.some((turn) => turn.id === turnId && turn.state === "completed")));
    const snapshot = snapshots.findLast((snapshot) => snapshot.turns.some((turn) => turn.id === turnId && turn.state === "completed"));
    assert.ok(snapshot, "Completed thread must have a durable transcript before any historical page read");
    assert.equal(snapshot.thread.id, threadId);
    assert.ok(snapshot.turns.some((turn) => turn.id === turnId && turn.state === "completed"));
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success, "The app's SQLite projector must accept the recorded transcript");
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
    assert.ok(items.some((item) => item.type === "mcpToolCall" && item.tool === "thread_status" && item.status === "completed"), "The agent must finish through Workbench's managed completion gate");
    assert.ok(items.some((item) => item.type === "commandExecution" && item.exitCode === 0), "A real agent CLI command must complete");
    await runtime.transcripts.unsubscribe({ subscriptionId });
    await runtime.stop();
    await runtime.start({ version: profiles.version, profiles: { [profile.id]: profile } }, prefixProof);
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 10 });
    assert.ok(reopened, "Transcript must survive a cold restart");
    assert.deepEqual(reopened.turns, snapshot.turns);
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, projection.data.turns, "Cold reopening must preserve all visible turn items");
    console.log("live admission, CLI/MCP and transcript checks passed");
  } catch (error) {
    console.error("live diagnostic failed", error);
    throw error;
  } finally {
    try {
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

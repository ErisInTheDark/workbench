/*
 * No exports. Explicitly selected paid-model test for the real OpenCode provider boundary.
 */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type {
  WorkbenchComposerProfile, WorkbenchPendingUserInputRequest, WorkbenchProjectsPayload,
} from "../../shared/types";
import type { TranscriptTextUpdate } from "../../shared/workbench/transcript/thread-transcript-stream";
import { workbenchTranscriptNotifications } from "../../shared/workbench/database/transcript/workbench-transcript-contract";
import { projectWorkbenchTranscript } from "../../shared/workbench/transcript/workbench-transcript-projection";
import OpenCodeServiceController, {
  type WorkbenchOpenCodeClient,
} from "../../daemon/server/providers/opencode/OpenCodeServiceController";
import IsolatedWorkbench from "./IsolatedWorkbench";
import {
  createProviderBoundaryJourney, PROVIDER_SEARCH_PROOF, PROVIDER_SEARCH_PROOF_FILE, PROVIDER_SHELL_PROOF_FILE,
} from "./provider-boundary-journey";

const file = "test/scenarios/opencode.scenario.test.ts";
const modelId = "opencode-go/muse-spark-1.3-contributor";

function passphrase() {
  const words = [
    "apple", "basket", "beach", "bird", "candle", "cherry", "cloud", "copper",
    "daisy", "drum", "fern", "forest", "garden", "grape", "horse", "island",
    "jacket", "kite", "lemon", "maple", "meadow", "moon", "ocean", "olive",
    "peach", "pencil", "rabbit", "river", "silver", "star", "tiger", "window",
  ];
  return Array.from({ length: 4 }, () => words.splice(randomInt(words.length), 1)[0]).join(" ");
}

type OpenCodeSession = Awaited<
  ReturnType<WorkbenchOpenCodeClient["session"]["list"]>
>["data"][number];

function isAbandonedTestSession(session: OpenCodeSession) {
  const workbench = session.metadata?.workbench;
  const testRunMarker = `${path.sep}.workbench${path.sep}test-runs${path.sep}wb-scenario-`;
  return session.title?.startsWith("opencode live ") === true
    && session.location.directory.includes(testRunMarker)
    && workbench !== null
    && typeof workbench === "object"
    && !Array.isArray(workbench)
    && workbench.managed === true
    && workbench.provider === "opencode";
}

async function removeAbandonedTestSessions(environment: NodeJS.ProcessEnv, dataRoot: string) {
  const service = new OpenCodeServiceController({
    environment: { ...environment, WORKBENCH_DATA_ROOT: dataRoot },
  });
  try {
    const client = await service.acquire();
    let cursor: string | undefined;
    do {
      const page = await client.session.list({
        cursor,
        limit: 100,
        order: "desc",
        search: "opencode live ",
      });
      for (const session of page.data) {
        if (isAbandonedTestSession(session)) {
          await client.session.remove({ sessionID: session.id });
        }
      }
      cursor = page.cursor.next;
    } while (cursor);
  } finally {
    await service.dispose();
  }
}

test("OpenCode creates, streams, persists, reopens, and safely removes one real session", {
  skip: process.env.WORKBENCH_OPENCODE_TEST_FILE !== file ? "run with pnpm test:opencode" : false,
}, async t => {
  const now = Date.now();
  const prefixProof = passphrase();
  const profile: WorkbenchComposerProfile = {
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
  const [database, configDirectory] = await Promise.all([
    IsolatedWorkbench.command("opencode", ["debug", "paths", "db"], source, process.env, t.signal),
    IsolatedWorkbench.command("opencode", ["debug", "paths", "config"], source, process.env, t.signal),
  ]);
  const openCodeEnvironment = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDirectory.trim(),
    OPENCODE_DB: database.trim(),
  };
  const runtime = await IsolatedWorkbench.create(source, t.signal, {
    codexIdentity: false,
    openCodeIdentity: {
      configDirectory: configDirectory.trim(),
      database: database.trim(),
    },
  });
  await removeAbandonedTestSessions(openCodeEnvironment, runtime.dataRootPath);
  let threadId: string | null = null;
  let nativeThreadId: string | null = null;
  let nativeSessionDeleted = false;
  let durableProjection: ReturnType<typeof projectWorkbenchTranscript> | null = null;
  try {
    await runtime.start([profile], prefixProof);
    console.log("[opencode live] isolated runtime started");
    const catalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    const project = catalog.data.find(entry => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(project, "Isolated project must be discoverable");
    const selection = {
      kind: "profile" as const,
      profileId: profile.id,
      settings: {
        agentPath: null,
        agentSource: null,
        harness: "opencode",
        model: profile.model,
        reasoningEffort: null,
        serviceTier: null,
      },
    };
    await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
    await runtime.request("profiles/target/set", {
      slot: { kind: "new-thread", projectId: project.id },
      selection,
    });
    const thread = await runtime.daemon.threads.create({
      projectId: project.id,
      context: { workflowIds: [] },
      profile: { kind: "target", slot: { kind: "new-thread", projectId: project.id } },
    });
    threadId = thread.id;
    console.log("[opencode live] WB thread and native session created");
    assert.equal(thread.harness, "opencode");
    assert.match(threadId, /^[0-9a-f-]{36}$/iu);
    const title = `opencode live ${randomUUID()}`;
    await runtime.daemon.threads.title({ threadId, title });

    const database = new Database(path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3"), {
      readonly: true,
    });
    try {
      const binding = database.prepare(
        "SELECT native_thread_id FROM workbench_pending_import_threads WHERE thread_id = ? AND harness_id = 'opencode'",
      ).get(threadId) as { native_thread_id: string } | undefined;
      assert.ok(binding, "The WB thread must own its OpenCode session immediately");
      nativeThreadId = binding.native_thread_id;
      assert.notEqual(nativeThreadId, threadId);
    } finally {
      database.close();
    }

    console.log("[opencode live] title updated");
    const cli = await IsolatedWorkbench.command("bash", [
      path.join(runtime.project, "daemon/node_modules/.bin/wb"), "task", "get",
    ], runtime.project, {
      ...process.env,
      WORKBENCH_DATA_ROOT: runtime.dataRootPath,
      WORKBENCH_HARNESS: "opencode",
      WORKBENCH_ORIGIN: runtime.origin,
      WORKBENCH_THREAD_ID: threadId,
    }, t.signal);
    assert.ok(cli.includes(title), "CLI must resolve the managed WB thread identity");
    console.log("[opencode live] managed CLI identity verified");

    await fs.writeFile(path.join(runtime.project, PROVIDER_SEARCH_PROOF_FILE), PROVIDER_SEARCH_PROOF);
    const journey = createProviderBoundaryJourney({
      search: "the wb_rg tool",
      shell: "the wb_shell tool",
      taskGet: "the wb_task_get tool",
      taskComplete: "the wb_task_completed tool",
      questionnaire: "the wb_request_user_input tool",
    });
    const subscriptionId = `opencode-${randomUUID()}`;
    const liveText = new Map<string, TranscriptTextUpdate>();
    const subscribe = () => runtime.transcripts.subscribe(
      { threadId: threadId!, turnLimit: 20, subscriptionId },
      () => {
        assert.fail("The OpenCode scenario must use the incremental SQLite transcript protocol");
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
    await subscribe();
    const waitForFact = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
      for (;;) {
        const offset = runtime.events.length;
        const value = await read();
        if (ready(value)) return value;
        await runtime.until(() => runtime.events.slice(offset).some(event =>
          ["questionnaire/requested", "questionnaire/resolved", "turn/completed", "item/completed"]
            .includes(event.method ?? "")
          || event.method === workbenchTranscriptNotifications.streamed.method
          || event.method === "workbench/thread-state/updated"));
      }
    };
    const durable = async () => {
      const snapshot = await runtime.transcripts.read({ threadId: threadId!, turnLimit: 30 });
      assert.ok(snapshot, "The OpenCode turn must be durable in SQLite");
      const projected = projectWorkbenchTranscript(snapshot);
      assert.ok(projected.success);
      return projected.data;
    };
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
          throw new Error(`OpenCode turn ${turnId} settled as ${turn.status}; expected ${status}.`);
        }
        return turn?.status === status;
      });
      return value;
    };
    const readRetainedQuestions = async () => {
      const state = await runtime.request<import("../../shared/workbench/thread/thread-state").WorkbenchThreadStateOpenResult>(
        "workbench/thread-state/open", { projectId: project.id, version: 4 },
      );
      return state.sidebar.entries.flatMap(entry =>
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
          .filter(question => question.harness === "opencode" && question.threadId === threadId),
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

    const sleepProof = passphrase();
    const steerProof = passphrase();
    const activeTurn = await submit(journey.active(prefixProof, sleepProof), "newTurn");
    await waitForFact(durable, value => JSON.stringify(value).includes(sleepProof));
    const steer = await runtime.daemon.threads.message({
      threadId,
      clientMessageId: randomUUID(),
      intent: "steer",
      expectedTurnId: activeTurn,
      input: [{ type: "text", text: journey.steer(steerProof), text_elements: [] }],
    });
    assert.deepEqual(steer, { kind: "steered", turnId: activeTurn });
    const liveQuestion = await pending("live_answer");
    const activeProjection = await durable();
    assert.ok(JSON.stringify(activeProjection).includes(prefixProof), "Managed instructions must reach OpenCode");
    assert.ok(JSON.stringify(activeProjection).includes(steerProof), "OpenCode must receive the active steer");
    const liveProof = passphrase();
    assert.equal((await answer(liveQuestion, "live_answer", liveProof)).route, "live");
    const heldQuestion = await pending("held_answer");
    assert.ok(JSON.stringify(await durable()).includes(liveProof));
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: heldQuestion.requestKey });
    await waitTurn(activeTurn, "interrupted");

    await runtime.stop();
    await runtime.start([profile], prefixProof);
    await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 });
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
    const dismissQuestion = await pending("dismiss_preserved");
    const continuedProjection = await durable();
    assert.ok(JSON.stringify(continuedProjection).includes(heldProof));
    await runtime.daemon.threads.stop({ threadId, intent: "snooze", requestKey: dismissQuestion.requestKey });
    await runtime.daemon.threads.stop({ threadId, intent: "stop", requestKey: dismissQuestion.requestKey });
    assert.ok(!(await readRetainedQuestions()).some(
      question => question.requestKey === dismissQuestion.requestKey,
    ));

    const stopProof = passphrase();
    const stoppedTurn = await submit(journey.stop(stopProof));
    await waitForFact(durable, value => JSON.stringify(value).includes(stopProof));
    await runtime.daemon.threads.stop({ threadId, intent: "stop", turnId: stoppedTurn });
    await waitTurn(stoppedTurn, "interrupted");
    const beforeCompact = await durable();
    await runtime.daemon.threads.compact({ threadId });
    await waitForFact(durable, value =>
      value.turns.flatMap(turn => turn.items).some(item => item.type === "contextCompaction")
      && value.turns.every(turn => turn.status !== "inProgress"));
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
    assert.ok(finalItems.some(item => item.type === "dynamicToolCall"
      && item.tool === "execute" && item.status === "completed"
      && item.contentItems?.some(content => content.type === "inputText"
        && content.text.includes(PROVIDER_SEARCH_PROOF))),
    "OpenCode must complete WB search and preserve its result");
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
      "The real OpenCode text stream must reach the shared live projection");
    await runtime.transcripts.unsubscribe({ subscriptionId });
    console.log("[opencode live] shared provider journey passed");

    await runtime.stop();
    await runtime.start([profile], prefixProof);
    console.log("[opencode live] isolated runtime cold-reopened");
    const reopened = await runtime.transcripts.read({ threadId, turnLimit: 20 });
    assert.ok(reopened, "The OpenCode transcript must survive a cold WB reopen");
    const reopenedProjection = projectWorkbenchTranscript(reopened);
    assert.ok(reopenedProjection.success && durableProjection.success);
    assert.deepEqual(reopenedProjection.data.turns, durableProjection.data.turns);

    await runtime.daemon.threads.deleteProvider({ threadId });
    nativeSessionDeleted = true;
    const verificationService = new OpenCodeServiceController({
      environment: { ...openCodeEnvironment, WORKBENCH_DATA_ROOT: runtime.dataRootPath },
    });
    const verificationClient = await verificationService.acquire();
    await assert.rejects(verificationClient.session.get({ sessionID: nativeThreadId }),
      "The diagnostic must delete only its exact native OpenCode session");
    await verificationService.dispose();
    const retained = await runtime.transcripts.read({ threadId, turnLimit: 20 });
    assert.ok(retained, "Deleting provider state must retain isolated WB transcript history");
    console.log("[opencode live] exact native deletion and WB history retention verified");
  } finally {
    const removeNativeSession = async () => {
      if (!threadId || !nativeThreadId || nativeSessionDeleted) return;
      const cleanupService = new OpenCodeServiceController({
        environment: { ...openCodeEnvironment, WORKBENCH_DATA_ROOT: runtime.dataRootPath },
      });
      try {
        const cleanupClient = await cleanupService.acquire();
        await cleanupClient.session.remove({ sessionID: nativeThreadId });
      } finally {
        await cleanupService.dispose();
      }
    };
    try {
      await removeNativeSession();
    } finally {
      await runtime.stop();
    }
  }
});

/*
 * No production exports. Tests protect virtual steers: held only for a questionnaire whose turn is not live, delivered in send order with the answer, retired only after acceptance, never stranded by a racing answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { WorkbenchUserInput } from "workbench-shared/workbench/provider/provider-input";
import WorkbenchQuestionnaireSteerController, { joinUserInputs } from "./WorkbenchQuestionnaireSteerController";

const text = (value: string, elements: Array<{ start: number; end: number }> = []): WorkbenchUserInput => ({
  type: "text", text: value, text_elements: elements.map(byteRange => ({ byteRange, placeholder: null })),
});

function setup(options: { questionnaire?: boolean; live?: boolean } = {}) {
  const state = { questionnaire: options.questionnaire ?? true, live: options.live ?? false };
  const steers: WorkbenchSteerHistoryEntry[] = [];
  let now = 100;
  const controller = new WorkbenchQuestionnaireSteerController({
    hasPendingQuestionnaire: async () => state.questionnaire,
    latestTurn: async () => ({ id: state.live ? "live" : "turn", live: state.live }),
    readSteers: async () => steers.map(entry => ({ ...entry })),
    record: async observations => {
      for (const observation of observations) {
        if (observation.kind !== "steer") continue;
        const index = steers.findIndex(entry => entry.entryKey === observation.entry.entryKey);
        const next = { ...observation.entry, itemId: `item:${observation.entry.entryKey}` } as WorkbenchSteerHistoryEntry;
        if (index === -1) steers.push(next);
        else steers[index] = next;
      }
      return undefined as never;
    },
    now: () => now++,
    warn: () => {},
  });
  const message = (id: string, value: string) => ({ clientMessageId: id, intent: "continue" as const, input: [text(value)] });
  return { controller, steers, state, message };
}

test("messages become virtual steers only while a held questionnaire's turn is not live", async () => {
  const held = setup();
  assert.equal(await held.controller.hold("thread",held.message("a", "first")), true);
  assert.deepEqual(held.steers.map(({ status, clientUserMessageId }) => [status, clientUserMessageId]), [["pending", "a"]]);

  const live = setup({ live: true });
  assert.equal(await live.controller.hold("thread",live.message("a", "first")), false);
  const noQuestion = setup({ questionnaire: false });
  assert.equal(await noQuestion.controller.hold("thread",noQuestion.message("a", "first")), false);
  assert.deepEqual([...live.steers, ...noQuestion.steers], []);
});

test("the answer's continuation carries virtual steers in send order and retires them once accepted", async () => {
  const { controller, steers, message } = setup();
  await controller.hold("thread",message("a", "first"));
  await controller.hold("thread",message("b", "second"));
  let delivered: WorkbenchUserInput[][] = [];
  await controller.deliverWith("thread", async input => { delivered = input; });
  assert.deepEqual(delivered, [[text("first")], [text("second")]]);
  assert.deepEqual(steers.map(({ status }) => status), ["dismissed", "dismissed"]);
});

test("a failed continuation leaves virtual steers pending", async () => {
  const { controller, steers, message } = setup();
  await controller.hold("thread",message("a", "first"));
  await assert.rejects(controller.deliverWith("thread", async () => { throw new Error("submit failed"); }));
  assert.deepEqual(steers.map(({ status }) => status), ["pending"]);
});

test("a message racing the answer is either delivered with it or sent to the live continuation, never stranded", async () => {
  const { controller, steers, state, message } = setup();
  const admitted = Promise.withResolvers<void>();
  let delivered: WorkbenchUserInput[][] = [];
  const answer = controller.deliverWith("thread", async input => {
    delivered = input;
    await admitted.promise;
    state.live = true;
  });
  const racing = controller.hold("thread",message("late", "late"));
  admitted.resolve();
  await answer;
  assert.equal(await racing, false, "the continuation's live turn takes it as an ordinary steer");
  assert.deepEqual(delivered, []);
  assert.deepEqual(steers, []);
});

test("once no questionnaire waits, virtual steers end undelivered while live-turn and compaction steers are left alone", async () => {
  const { controller, steers, state, message } = setup();
  await controller.hold("thread", message("a", "virtual"));
  state.questionnaire = false;
  state.live = true;
  const pending = (entryKey: string, turnId: string): WorkbenchSteerHistoryEntry => ({
    entryKey, turnId, itemId: `item:${entryKey}`, threadId: "thread", input: [{ type: "text", text: entryKey, text_elements: [] }], status: "pending",
    attemptedAt: 1, resolvedAt: null, requestId: null, canonicalItemId: null, error: null,
  });
  steers.push(pending("live-steer", "live"), pending("compaction:queued", "turn"));
  await controller.release("thread");
  assert.deepEqual(steers.map(({ entryKey, status }) => `${entryKey}:${status}`),
    ["questionnaire:a:interrupted", "live-steer:pending", "compaction:queued:pending"]);
});

test("release keeps virtual steers while their questionnaire still waits", async () => {
  const { controller, steers, message } = setup();
  await controller.hold("thread", message("a", "virtual"));
  await controller.release("thread");
  assert.deepEqual(steers.map(({ status }) => status), ["pending"]);
});

test("joined messages read as one blank-line separated text that keeps its element ranges", () => {
  const image = { type: "image" as const, url: "data:image/png;base64,aGVsbG8=" };
  const joined = joinUserInputs([[text("hé")], [text("@x", [{ start: 0, end: 2 }]), image], [text("after")]]);
  assert.deepEqual(joined, [text("hé\n\n@x", [{ start: 5, end: 7 }]), image, text("after")]);
});

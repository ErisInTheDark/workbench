/* No production exports. Protect complete-turn paging, retained boundaries and cancellation. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessageInfo } from "@opencode/client";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";
import OpenCodeThreadWindowLoader from "./OpenCodeThreadWindowLoader";

function message(id: string, type: "user" | "assistant" = "assistant", steer = false): SessionMessageInfo {
  return {
    id, type, sessionID: "session", time: { created: 1 }, parts: [], text: "",
    ...(steer ? { metadata: { workbench: {
      version: 1, delivery: "steer", itemId: "00000000-0000-4000-8000-000000000001",
      clientMessageId: id, input: [],
    } } } : {}),
  } as SessionMessageInfo;
}

function fixture(pages: Array<{ data: SessionMessageInfo[]; next?: string }>) {
  const calls: Array<string | null> = [];
  let active = 0;
  let maximum = 0;
  const client = { message: { list: async (input: { cursor?: string }) => {
    calls.push(input.cursor ?? null);
    maximum = Math.max(maximum, ++active);
    const page = pages[input.cursor ? Number(input.cursor) : 0]!;
    await Promise.resolve();
    active--;
    return { data: page.data, cursor: { next: page.next } };
  } } } as WorkbenchOpenCodeClient;
  return { loader: new OpenCodeThreadWindowLoader(client), calls, get maximum() { return maximum; } };
}

test("latest keeps cross-page steers within one complete turn and resumes its predecessor", async () => {
  const f = fixture([
    { data: [message("answer"), message("steer", "user", true)], next: "1" },
    { data: [message("earlier-answer"), message("root", "user"), message("old-answer"), message("old-root", "user")] },
  ]);
  const signal = new AbortController().signal;
  const latest = await f.loader.load("session", { mode: "latest" }, undefined, signal);
  assert.deepEqual(latest.messages.map(value => value.id), ["root", "earlier-answer", "steer", "answer"]);
  assert.equal(f.maximum, 1);
  const previous = await f.loader.load("session", { mode: "previous", beforeTurnId: "root" }, latest.previousCursor, signal);
  assert.deepEqual(previous.messages.map(value => value.id), ["old-root", "old-answer"]);
  assert.equal(previous.previousCursor, null);
  assert.deepEqual(f.calls, [null, "1", "1"]);
});

test("retained first-page boundary remains usable after newer messages push it onto another page", async () => {
  const pages = [{ data: [message("root", "user"), message("older", "user")], next: "1" }];
  const f = fixture(pages);
  const signal = new AbortController().signal;
  const latest = await f.loader.load("session", { mode: "latest" }, undefined, signal);
  pages[0] = { data: [message("new-answer"), message("new-root", "user")], next: "1" };
  pages[1] = { data: [message("root", "user"), message("older", "user")], next: undefined };
  const previous = await f.loader.load("session", { mode: "previous", beforeTurnId: "root" }, latest.previousCursor, signal);
  assert.deepEqual(previous.messages.map(value => value.id), ["older"]);
});

test("scrolling a large archive advances only the demanded complete turns", async () => {
  const f = fixture(Array.from({ length: 200 }, (_, index) => ({
    data: [message(`answer-${index}`), message(`root-${index}`, "user")],
    ...(index < 199 ? { next: String(index + 1) } : {}),
  })));
  const signal = new AbortController().signal;
  let window = await f.loader.load("session", { mode: "latest" }, undefined, signal);
  for (let index = 1; index <= 2; index++) {
    window = await f.loader.load("session", {
      mode: "previous", beforeTurnId: `root-${index - 1}`,
    }, window.previousCursor, signal);
    assert.deepEqual(window.messages.map(value => value.id), [`root-${index}`, `answer-${index}`]);
  }
  assert.deepEqual(f.calls, [null, "1", "2"]);
  assert.equal(f.maximum, 1);
});

test("exact seek discards unrelated turns and rejects an omitted target", async () => {
  const f = fixture([
    { data: [message("new-answer"), message("new-root", "user")], next: "1" },
    { data: [message("answer"), message("root", "user"), message("older", "user")] },
  ]);
  const signal = new AbortController().signal;
  const exact = await f.loader.load("session", { mode: "exact", turnId: "root" }, undefined, signal);
  assert.deepEqual(exact.messages.map(value => value.id), ["root", "answer"]);
  await assert.rejects(f.loader.load("session", { mode: "exact", turnId: "missing" }, undefined, signal), /boundary/);
});

test("repeated provider cursors cannot spin recovery indefinitely", async () => {
  const f = fixture([{ data: [message("answer")], next: "1" }, { data: [message("earlier")], next: "1" }]);
  await assert.rejects(f.loader.load("session", { mode: "latest" }, undefined, new AbortController().signal), /repeated a cursor/);
  assert.equal(f.calls.length, 2);
});

test("retirement after an in-flight page prevents further native requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  const loader = new OpenCodeThreadWindowLoader({ message: { list: async () => {
    calls++;
    controller.abort(new Error("retired"));
    return { data: [message("answer")], cursor: { next: "more" } };
  } } } as Pick<WorkbenchOpenCodeClient, "message">);
  await assert.rejects(loader.load("session", { mode: "latest" }, undefined, controller.signal), /retired/);
  assert.equal(calls, 1);
});

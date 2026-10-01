/* No production exports. Tests protect when a pending steer may end a managed model response. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import OpenCodeSteerCutController from "./OpenCodeSteerCutController";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const reasoning = { choices: [{ index: 0, delta: { reasoning_content: "thinking" } }] };
const commentary = { choices: [{ index: 0, delta: { content: "working" } }] };
const opening = { id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] };

/** A provider body the test feeds frame by frame, plus OpenCode's reader of the tapped response. */
function provider(sessionID = "managed") {
  const queued: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!queued.length && !cancelled) await new Promise<void>(resolve => { wake = resolve; });
      if (queued.length) controller.enqueue(queued.shift()!);
    },
    cancel() { cancelled = true; wake?.(); },
  }, { highWaterMark: 0 });
  const input = { kind: "primary", sessionID,
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }) } as SessionHttpResponse;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return {
    input,
    cancelled: () => cancelled,
    send(frame: object) { queued.push(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)); wake?.(); },
    async read() {
      reader ??= input.response.body!.getReader();
      const chunk = await reader.read();
      return chunk.done ? null : decoder.decode(chunk.value);
    },
  };
}

function controller(managed = true) {
  const warnings: string[] = [];
  const owner = new OpenCodeSteerCutController({ isManagedSession: async () => managed, warn: message => warnings.push(message) });
  return { owner, warnings };
}

test("a steer during reasoning ends the response cleanly and cancels the provider", async () => {
  const { owner, warnings } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(reasoning);
  await body.read();
  const waiting = body.read();
  await owner.steerPending("managed", "steer-1");
  assert.match((await waiting)!, /"finish_reason":"stop"[\s\S]*data: \[DONE\]/u);
  assert.equal(await body.read(), null);
  assert.equal(body.cancelled(), true);
  assert.deepEqual(warnings, []);
});

test("a steer pending before reasoning cuts at the first reasoning frame", async () => {
  const { owner } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  await owner.steerPending("managed", "steer-1");
  body.send(opening);
  assert.match((await body.read())!, /"role":"assistant"/u);
  body.send(reasoning);
  assert.match((await body.read())!, /reasoning_content/u, "the reasoning frame is kept before the ending");
  assert.match((await body.read())!, /"finish_reason":"stop"/u);
  assert.equal(await body.read(), null);
});

test("commentary and resolved steers are never cut", async () => {
  const { owner } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(commentary);
  await body.read();
  await owner.steerPending("managed", "steer-1");
  owner.steerResolved("managed", "steer-1");
  body.send(reasoning);
  assert.match((await body.read())!, /reasoning_content/u);
  assert.equal(body.cancelled(), false);
  const late = provider();
  await owner.httpResponse(late.input);
  await owner.steerPending("managed", "steer-2");
  owner.steerResolved("managed", "steer-2");
  late.send(opening);
  await late.read();
  late.send(reasoning);
  assert.doesNotMatch((await late.read())!, /finish_reason":"stop"/u);
});

test("each steer cuts at most once even if its delivery is never observed", async () => {
  const { owner } = controller();
  const first = provider();
  await owner.httpResponse(first.input);
  first.send(opening);
  await first.read();
  first.send(reasoning);
  await first.read();
  await owner.steerPending("managed", "steer-1");
  assert.match((await first.read())!, /\[DONE\]/u);
  const next = provider();
  await owner.httpResponse(next.input);
  await owner.steerPending("managed", "steer-1");
  next.send(opening);
  await next.read();
  next.send(reasoning);
  assert.doesNotMatch((await next.read())!, /\[DONE\]/u);
  assert.equal(next.cancelled(), false);
});

test("unmanaged sessions keep their native response object", async () => {
  const { owner } = controller(false);
  const body = provider("ordinary");
  const native = body.input.response;
  await owner.httpResponse(body.input);
  assert.equal(body.input.response, native);
});

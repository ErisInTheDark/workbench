/* No production exports. Tests protect when a managed model response is ended early, for a pending steer, bare text or an ended turn. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import OpenCodeStreamCutController from "./OpenCodeStreamCutController";
import { OPENCODE_COMMENTARY_TOOL_NAME } from "../opencode-workbench-rpc";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const reasoning = { choices: [{ index: 0, delta: { reasoning_content: "thinking" } }] };
const commentary = { choices: [{ index: 0, delta: { content: "working" } }] };
const whitespace = { choices: [{ index: 0, delta: { content: "\n\n" } }] };
const toolCall = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "x", arguments: "{}" } }] } }] };
const opening = { id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] };

/** A provider body the test feeds frame by frame, plus OpenCode's reader of the tapped response. */
function provider(sessionID = "managed") {
  const queued: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let cancelled = false;
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!queued.length && !cancelled && !ended) await new Promise<void>(resolve => { wake = resolve; });
      if (queued.length) controller.enqueue(queued.shift()!);
      else if (ended) controller.close();
    },
    cancel() { cancelled = true; wake?.(); },
  }, { highWaterMark: 0 });
  const input = { kind: "primary", sessionID,
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }) } as SessionHttpResponse;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return {
    input,
    cancelled: () => cancelled,
    /** Frames sent together arrive as one provider chunk; a string frame is sent verbatim as event data. */
    send(...frames: (object | string)[]) {
      queued.push(encoder.encode(frames.map(frame =>
        `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("")));
      wake?.();
    },
    end() { ended = true; wake?.(); },
    async read() {
      reader ??= input.response.body!.getReader();
      const chunk = await reader.read();
      return chunk.done ? null : decoder.decode(chunk.value);
    },
  };
}

function controller(options: { managed?: boolean; hint?: () => Promise<void> } = {}) {
  const warnings: string[] = [];
  const hints: string[] = [];
  const owner = new OpenCodeStreamCutController({
    isManagedSession: async () => options.managed ?? true,
    hint: async sessionID => { hints.push(sessionID); await options.hint?.(); },
    warn: message => warnings.push(message),
  });
  return { owner, warnings, hints };
}

async function bareTextResponse(owner: OpenCodeStreamCutController) {
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(commentary);
  return { body, output: await body.read() };
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

test("open tool calls and resolved steers are never cut for a steer", async () => {
  const { owner } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(toolCall);
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

test("bare text never reaches OpenCode; the hint is admitted before the clean ending", async () => {
  let ended = false;
  const { owner, hints, warnings } = controller({ hint: async () => { assert.equal(ended, false); } });
  const { body, output } = await bareTextResponse(owner);
  ended = true;
  assert.deepEqual(hints, ["managed"]);
  assert.doesNotMatch(output!, /working/u);
  assert.match(output!, /"finish_reason":"stop"[\s\S]*data: \[DONE\]/u);
  assert.equal(await body.read(), null);
  assert.equal(body.cancelled(), true);
  assert.deepEqual(warnings, []);
});

test("bare text after a finished tool call keeps the tool call and ends for tool execution", async () => {
  const { owner, hints } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(toolCall);
  assert.match((await body.read())!, /tool_calls/u);
  body.send(commentary);
  const output = await body.read();
  assert.doesNotMatch(output!, /working/u);
  assert.match(output!, /"finish_reason":"tool_calls"/u);
  assert.deepEqual(hints, ["managed"]);
});

test("whitespace text is held, then released unchanged with the next frame", async () => {
  const { owner, hints } = controller();
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(whitespace);
  body.send(toolCall);
  const output = await body.read();
  assert.match(output!, /"content":"\\n\\n"[\s\S]*tool_calls/u);
  body.end();
  assert.equal(await body.read(), null);
  assert.deepEqual(hints, []);
});

test("repeated bare text stops being cut until the agent calls a work tool, even if it obeys each hint", async () => {
  const { owner, hints, warnings } = controller();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.doesNotMatch((await bareTextResponse(owner)).output!, /working/u);
    owner.toolCalled("managed", OPENCODE_COMMENTARY_TOOL_NAME);
  }
  assert.equal(warnings.length, 1, "reaching the limit is reported once");
  assert.match((await bareTextResponse(owner)).output!, /working/u, "the next bare text is kept so the turn can end");
  owner.toolCalled("managed", "wbex_shell");
  assert.doesNotMatch((await bareTextResponse(owner)).output!, /working/u, "a work tool call restores the cut");
  assert.equal(hints.length, 4);
});

test("once the execution set its task status, bare text is kept so it ends the turn", async () => {
  const { owner, hints } = controller();
  assert.doesNotMatch((await bareTextResponse(owner)).output!, /working/u);
  owner.taskStatusSet("managed");
  assert.equal(owner.hasTaskStatus("managed"), true);
  assert.match((await bareTextResponse(owner)).output!, /working/u);
  assert.equal(hints.length, 1, "a finished agent is not hinted");
  owner.settleSession("managed");
  assert.equal(owner.hasTaskStatus("managed"), false, "the next execution must set its status again");
  assert.doesNotMatch((await bareTextResponse(owner)).output!, /working/u);
  assert.equal(hints.length, 2);
});

test("an ended turn cuts the next response empty at its first frame, without a hint", async () => {
  const { owner, hints, warnings } = controller();
  owner.taskStatusSet("managed");
  const current = provider();
  await owner.httpResponse(current.input);
  assert.equal(owner.endTurn("managed"), "ending");
  current.send(commentary);
  assert.match((await current.read())!, /working/u, "the response that called the tool is not cut");
  const next = provider();
  await owner.httpResponse(next.input);
  next.send({ ...opening, choices: [{ index: 0, delta: { role: "assistant", content: "leak" } }] });
  const output = await next.read();
  assert.doesNotMatch(output!, /leak|"role"/u);
  assert.match(output!, /"finish_reason":"stop"[\s\S]*data: \[DONE\]/u);
  assert.equal(await next.read(), null);
  assert.equal(next.cancelled(), true);
  const after = provider();
  await owner.httpResponse(after.input);
  after.send(opening);
  assert.match((await after.read())!, /"role":"assistant"/u, "one call ends one response");
  assert.deepEqual(hints, []);
  assert.deepEqual(warnings, []);
});

test("an ended turn's next response is cut empty even when it arrives whole with its [DONE]", async () => {
  const { owner } = controller();
  owner.taskStatusSet("managed");
  owner.endTurn("managed");
  const next = provider();
  await owner.httpResponse(next.input);
  next.send(opening, commentary, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, "[DONE]");
  const output = await next.read();
  assert.doesNotMatch(output!, /working|"role"/u);
  assert.match(output!, /"finish_reason":"stop"[\s\S]*data: \[DONE\]/u);
});

test("ending a turn needs a task status and yields to a pending or later steer", async () => {
  const { owner } = controller();
  assert.equal(owner.endTurn("managed"), "status-missing");
  owner.taskStatusSet("managed");
  await owner.steerPending("managed", "steer-1");
  assert.equal(owner.endTurn("managed"), "steer-pending");
  owner.steerResolved("managed", "steer-1");
  assert.equal(owner.endTurn("managed"), "ending");
  await owner.steerPending("managed", "steer-2");
  owner.steerResolved("managed", "steer-2");
  const steered = provider();
  await owner.httpResponse(steered.input);
  steered.send(opening);
  assert.match((await steered.read())!, /"role":"assistant"/u, "the steered step must answer the steer");
  assert.equal(owner.endTurn("managed"), "ending");
  owner.settleSession("managed");
  const next = provider();
  await owner.httpResponse(next.input);
  next.send(opening);
  assert.match((await next.read())!, /"role":"assistant"/u, "a settled execution forgets its ending");
  owner.dispose();
  assert.equal(owner.endTurn("managed"), "unavailable");
});

test("an ending that meets an unsupported wire is dropped with a warning instead of chopping a later response", async () => {
  const { owner, warnings } = controller();
  owner.taskStatusSet("managed");
  owner.endTurn("managed");
  const unsupported = provider();
  await owner.httpResponse(unsupported.input);
  unsupported.send({ type: "response.created" });
  assert.match((await unsupported.read())!, /response\.created/u);
  assert.equal(warnings.length, 1);
  const next = provider();
  await owner.httpResponse(next.input);
  next.send(opening);
  assert.match((await next.read())!, /"role":"assistant"/u);
});

test("a failed hint keeps the bare text instead of ending the response silently", async () => {
  const { owner, warnings } = controller({ hint: async () => { throw new Error("inbox closed"); } });
  const body = provider();
  await owner.httpResponse(body.input);
  body.send(opening);
  await body.read();
  body.send(commentary);
  body.send(toolCall);
  const output = await body.read();
  assert.match(output!, /working[\s\S]*tool_calls/u);
  assert.equal(body.cancelled(), false);
  assert.equal(warnings.length, 1);
});

test("unmanaged sessions keep their native response object", async () => {
  const { owner } = controller({ managed: false });
  const body = provider("ordinary");
  const native = body.input.response;
  await owner.httpResponse(body.input);
  assert.equal(body.input.response, native);
});

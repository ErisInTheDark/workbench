/* No production exports. Tests protect native transport isolation and request-fenced preview lifecycle. */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHttpResponse } from "@opencode/plugin/promise/session";
import type { OpenCodePatchObservation } from "../opencode-workbench-rpc";
import OpenCodePatchStreamController from "./OpenCodePatchStreamController";

test("malformed preview frames warn once and still forward native bytes", async () => {
  const observations: OpenCodePatchObservation[] = [];
  const warnings: string[] = [];
  const owner = new OpenCodePatchStreamController({
    isManagedSession: async () => true,
    emit: async event => { observations.push(event); },
    warn: message => warnings.push(message),
  });
  const text = "data: secret-malformed-data\n\ndata: still-forwarded\n\n";
  const input = {
    kind: "primary", sessionID: "managed",
    response: new Response(text, { headers: { "content-type": "text/event-stream" } }),
  } as SessionHttpResponse;
  await owner.httpResponse(input);
  assert.equal(await input.response.text(), text);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.includes("secret-malformed-data"), false);
  assert.deepEqual(observations.map(event => event.kind), ["request", "withdraw"]);
  await owner.dispose();
});

test("does not acquire unmanaged or auxiliary response bodies", async () => {
  const owner = new OpenCodePatchStreamController({
    isManagedSession: async () => false,
    emit: async () => { assert.fail("unmanaged response must not emit"); },
    warn: () => { assert.fail("unmanaged response must not warn"); },
  });
  const response = new Response("data: unchanged\n\n", { headers: { "content-type": "text/event-stream" } });
  const input = { kind: "primary", sessionID: "ordinary", response } as SessionHttpResponse;
  await owner.httpResponse(input);
  assert.equal(input.response, response);
  assert.equal(response.bodyUsed, false);
  await owner.dispose();
});

test("reused WebSocket sessions receive fresh request identities without frame mutation", async () => {
  const observations: OpenCodePatchObservation[] = [];
  const owner = new OpenCodePatchStreamController({
    isManagedSession: async () => true,
    emit: async event => { observations.push(event); },
    warn: message => assert.fail(message),
  });
  const send = { kind: "primary", sessionID: "managed", frame: '{"type":"response.create"}' } as const;
  await owner.websocketSend(send as never);
  await owner.websocketReceive({
    ...send, frame: JSON.stringify({ type: "response.output_item.added", item: {
      type: "function_call", id: "item", call_id: "call", name: "write", arguments: "",
    } }),
  } as never);
  const receive = { ...send, frame: JSON.stringify({
    type: "response.function_call_arguments.delta", item_id: "item", delta: '{"path":"src/a.ts","content":"',
  }) };
  const original = receive.frame;
  await owner.websocketReceive(receive as never);
  assert.equal(receive.frame, original);
  assert.ok(observations.some(event => event.kind === "preview" && event.files[0]?.path === "src/a.ts"));
  await owner.websocketSend(send as never);
  const requests = observations.filter(event => event.kind === "request");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]!.requestID, requests[1]!.requestID);
  assert.ok(observations.some(event => event.kind === "withdraw" && event.requestID === requests[0]!.requestID));
  await owner.dispose();
});

test("native interruption withdraws observation without consuming or cancelling native transport", async () => {
  const observations: OpenCodePatchObservation[] = [];
  let pulls = 0;
  let cancelled: unknown;
  const owner = new OpenCodePatchStreamController({
    isManagedSession: async () => true,
    emit: async event => { observations.push(event); },
    warn: message => assert.fail(message),
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 });
  const input = { kind: "primary", sessionID: "managed",
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }) } as SessionHttpResponse;
  await owner.httpResponse(input);
  assert.equal(pulls, 0);
  await owner.settleSession("managed");
  assert.equal(cancelled, undefined);
  assert.equal(observations.at(-1)?.kind, "withdraw");
  const reader = input.response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: [DONE]\n\n");
  assert.equal(pulls, 1);
  await reader.cancel("native cancelled");
  assert.equal(cancelled, "native cancelled");
  reader.releaseLock();
  await owner.dispose();
});

/* No production exports. Protect app-lifetime transport gating and compatibility. */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppLifetimeClient from "./WorkbenchAppLifetimeClient";

test("app loss suspends daemon transport and app return resumes it", async () => {
  const source = new EventTarget();
  const opened = Promise.withResolvers<void>();
  const availability: boolean[] = [];
  let closed = false;
  const owner = new WorkbenchAppLifetimeClient({
    available: value => availability.push(value), status: () => {},
    fetcher: async () => new Response(null, { status: 200 }),
    open: () => { opened.resolve(); return { addEventListener: source.addEventListener.bind(source), close: () => { closed = true; } }; },
  });
  const ready = owner.start();
  await opened.promise;
  assert.deepEqual(availability, [false]);
  source.dispatchEvent(new Event("ready"));
  await ready;
  source.dispatchEvent(new Event("stopped"));
  source.dispatchEvent(new Event("ready"));
  assert.deepEqual(availability, [false, true, false, true]);
  owner.dispose();
  assert.equal(closed, true);
  source.dispatchEvent(new Event("ready"));
  assert.equal(availability.length, 4);
});

test("only an absent old-server endpoint allows compatibility transport", async () => {
  for (const status of [404, 403, 503]) {
    const availability: boolean[] = [];
    const owner = new WorkbenchAppLifetimeClient({
      available: value => availability.push(value), status: () => {},
      fetcher: async () => new Response(null, { status }),
      open: () => { throw new Error("Unexpected stream"); },
    });
    if (status === 404) await owner.start();
    else await assert.rejects(owner.start(), /unavailable/);
    assert.deepEqual(availability, status === 404 ? [false, true] : [false]);
    owner.dispose();
  }
});

test("advertised app lifetime socket gates availability and closes with its owner", async context => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "http://127.0.0.1:4200/workbench" },
  } });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  class Socket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
    send() {}
    close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
    publish(kind: "ready" | "stopped") {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ kind }) }));
    }
  }
  const created = Promise.withResolvers<Socket>();
  const availability: boolean[] = [];
  const owner = new WorkbenchAppLifetimeClient({
    available: value => availability.push(value), status: () => {},
    fetcher: async () => new Response(null, {
      status: 200, headers: { "x-workbench-app-lifetime-socket": "1" },
    }),
    open: () => { throw new Error("Unexpected EventSource"); },
    socket: () => {
      const socket = new Socket();
      created.resolve(socket);
      return socket as unknown as WebSocket;
    },
  });
  context.after(() => owner.dispose());
  const started = owner.start();
  const socket = await created.promise;
  socket.open();
  assert.deepEqual(availability, [false]);
  socket.publish("ready");
  await started;
  socket.publish("stopped");
  socket.publish("ready");
  assert.deepEqual(availability, [false, true, false, true]);
  owner.dispose();
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

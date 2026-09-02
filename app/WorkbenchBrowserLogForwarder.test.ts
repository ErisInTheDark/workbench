/*
 * No production exports. Tests protect preserved console output, bounded forwarding, and non-recursive transport failure.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchBrowserLogForwarder from "./WorkbenchBrowserLogForwarder.ts";

test("preserves console warnings and forwards cycle-safe client entries", () => {
  const visible: unknown[][] = [];
  const requests: string[] = [];
  const scheduled: Array<() => void> = [];
  let scheduleReceiver: unknown;
  const listeners = new Map<string, EventListener>();
  const fakeConsole = {
    error: (...values: unknown[]) => visible.push(["error", ...values]),
    warn: (...values: unknown[]) => visible.push(["warn", ...values]),
  } as Pick<Console, "error" | "warn">;
  const forwarder = new WorkbenchBrowserLogForwarder({
    console: fakeConsole,
    fetcher: ((_input, init) => {
      requests.push(String(init?.body));
      return Promise.resolve(new Response("{}", { status: 202 }));
    }) as typeof fetch,
    schedule: function (this: unknown, callback) {
      scheduleReceiver = this;
      scheduled.push(callback);
    },
    target: {
      addEventListener: ((name: string, listener: EventListener) => listeners.set(name, listener)) as Window["addEventListener"],
      removeEventListener: ((name: string) => listeners.delete(name)) as Window["removeEventListener"],
    },
  });
  forwarder.install();
  const cyclic: { self?: object } = {};
  cyclic.self = cyclic;
  fakeConsole.warn("careful", cyclic);
  assert.equal(scheduleReceiver, undefined);
  assert.deepEqual(visible[0]?.slice(0, 2), ["warn", "careful"]);
  scheduled.shift()?.();
  assert.match(requests[0] ?? "", /"level":"warn"/u);
  assert.match(requests[0] ?? "", /\[circular\]/u);
  forwarder.dispose();
});

test("transport failure reports through the captured console method without enqueueing itself", async () => {
  const visible: unknown[][] = [];
  const scheduled: Array<() => void> = [];
  const fakeConsole = {
    error: (...values: unknown[]) => visible.push(values),
    warn: () => {},
  } as Pick<Console, "error" | "warn">;
  const forwarder = new WorkbenchBrowserLogForwarder({
    console: fakeConsole,
    fetcher: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    schedule: (callback) => scheduled.push(callback),
    target: { addEventListener: (() => {}) as Window["addEventListener"], removeEventListener: (() => {}) as Window["removeEventListener"] },
  });
  forwarder.install();
  fakeConsole.error("boom");
  scheduled.shift()?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(visible.length, 2);
  assert.match(String(visible[1]?.[0]), /could not forward/u);
  forwarder.dispose();
});

/*
 * No production exports. Tests protect that a project's MCP servers are released only when its last working thread stops,
 * independently per project, including threads seeded as working at start.
 */
import assert from "node:assert/strict";
import test from "node:test";
import McpProjectServerLifetime from "./McpProjectServerLifetime";

function setup(working: { projectId: string; threadId: string }[] = []) {
  let publish!: (projectId: string, threadId: string, working: boolean) => void;
  const released: string[] = [];
  const active: string[] = [];
  const lifetime = new McpProjectServerLifetime({
    readWorking: async () => working,
    subscribe: listener => { publish = listener; return () => undefined; },
    release: projectId => released.push(projectId),
    active: projectId => active.push(projectId),
    warn: () => undefined,
  });
  return { lifetime, released, active, publish: (...args: Parameters<typeof publish>) => publish(...args) };
}

test("a project's servers are released when its last working thread stops, not before, and other projects are untouched", async () => {
  const { lifetime, released, publish } = setup();
  await lifetime.start();
  publish("a", "t1", true);
  publish("a", "t2", true);
  publish("b", "t3", true);
  publish("a", "t1", false);
  assert.deepEqual(released, []);
  publish("a", "t2", false);
  assert.deepEqual(released, ["a"]);
  publish("b", "t3", false);
  assert.deepEqual(released, ["a", "b"]);
});

test("threads already working at start keep their project's servers until they stop", async () => {
  const { lifetime, released, active, publish } = setup([{ projectId: "a", threadId: "t1" }, { projectId: "a", threadId: "t2" }]);
  await lifetime.start();
  assert.ok(active.includes("a"), "a project working at start counts as active");
  publish("a", "t1", false);
  assert.deepEqual(released, []);
  publish("a", "t2", false);
  assert.deepEqual(released, ["a"]);
});

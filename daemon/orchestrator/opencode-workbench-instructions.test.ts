/*
 * Exports:
 * - No production exports; Node tests cover OpenCode thread identity injection for wb commands. Keywords: opencode, thread, identity, environment, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as instructions from "./opencode-workbench-instructions";

test("OpenCode hooks expose the supplied WB identity without replacing unrelated instructions", async () => {
  const source = instructions.buildOpenCodeSystemReplacementPluginSource();
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const plugin = await module.WorkbenchSystemReplacementPlugin() as {
    "shell.env"(input: { sessionID: string }, output: { env: Record<string, string> }): Promise<void>;
    "experimental.chat.system.transform"(input: { sessionID: string }, output: { system: string[] }): Promise<void>;
  };
  await assert.rejects(plugin["shell.env"]({ sessionID: "unobserved" }, { env: {} }), /identity/i);
  const wrap = instructions.withOpenCodeWorkbenchThreadIdentity;
  const publicId = "a9ef71fc-f20d-4578-99a7-d6e88abdc8c4";
  const prompt = instructions.buildOpenCodeWorkbenchSystemPrompt({ baseInstructions: "base rule", developerInstructions: "developer rule" })!;
  const system = { system: ["provider defaults", wrap(prompt, publicId)] };
  await plugin["experimental.chat.system.transform"]({ sessionID: "native-one" }, system);
  assert.equal(system.system.length, 1);
  assert.ok(system.system[0]!.includes("base rule"));
  assert.ok(system.system[0]!.includes("developer rule"));
  assert.ok(!system.system[0]!.includes("provider defaults"));
  const other = { system: ["untouched provider defaults", wrap(null, "b707ce32-6f41-460a-9248-8d7b97095bd9")] };
  await plugin["experimental.chat.system.transform"]({ sessionID: "native-two" }, other);
  assert.deepEqual(other.system, ["untouched provider defaults"]);
  const output = { env: { EXISTING: "value" } as Record<string, string> };
  await plugin["shell.env"]({ sessionID: "native-one" }, output);
  assert.deepEqual(output.env, { EXISTING: "value", WORKBENCH_THREAD_ID: publicId, WORKBENCH_HARNESS: "opencode" });
});

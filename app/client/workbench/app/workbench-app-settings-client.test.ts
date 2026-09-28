/* No production exports. Protect app settings boundary admission without transport fallback. */
import assert from "node:assert/strict";
import test from "node:test";
import { readWorkbenchAppSettings, updateWorkbenchAppSettings } from "./workbench-app-settings-client";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";

test("a malformed settings response fails visibly rather than becoming an old-server fallback", async context => {
  context.mock.method(console, "error", () => {});
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const reading = readWorkbenchAppSettings(fixture.rpc);
  const rejected = assert.rejects(reading, /invalid/);
  socket.reply(await socket.request("app/settings/read"), {
    appliedReactDevelopmentMode: "false", requestedReactDevelopmentMode: true,
  });
  await rejected;
  const writing = updateWorkbenchAppSettings(true, fixture.rpc);
  const request = await socket.request("app/settings/update");
  const data = { appliedReactDevelopmentMode: false, requestedReactDevelopmentMode: true };
  socket.reply(request, data);
  assert.deepEqual(await writing, data);
});

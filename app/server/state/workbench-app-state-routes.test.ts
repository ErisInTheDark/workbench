/* No production exports. Protect old browser-state reads while adding daemon-qualified registrations. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchAppStateRepository from "./WorkbenchAppStateRepository.ts";
import WorkbenchBrowserStateRegistry from "./WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppStateRoutes from "./workbench-app-state-routes.ts";

test("registration metadata is negotiated without changing legacy app-state responses", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-app-state-capability-"));
  const repository = new WorkbenchAppStateRepository({ databasePath: path.join(root, "state.sqlite3") });
  await repository.start();
  const registry = new WorkbenchBrowserStateRegistry(repository);
  registry.start();
  const routes = new WorkbenchAppStateRoutes(registry);
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost"));
  });
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await registry.close();
    await repository.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const legacy = await (await fetch(`${origin}/api/workbench-client-state`)).json();
  const modern = await (await fetch(`${origin}/api/workbench-client-state?capabilities=2`)).json();
  assert.ok(legacy && typeof legacy === "object");
  assert.ok(modern && typeof modern === "object");
  assert.equal("registrations" in legacy, false);
  assert.ok("registrations" in modern);
});

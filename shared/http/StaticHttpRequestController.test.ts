/*
 * No production exports. Tests protect reloadable static resolution without listener ownership.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import StaticHttpRequestController from "./StaticHttpRequestController.ts";

test("starts and closes independently from a socket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-static-controller-"));
  await writeFile(path.join(root, "index.html"), "ready", "utf8");
  const controller = new StaticHttpRequestController({ rootDirectoryPath: root });
  await controller.start();
  controller.close();
  await assert.rejects(
    controller.handleRequest({ headers: {}, method: "GET", url: "/" } as IncomingMessage, {} as ServerResponse),
    /not running/u,
  );
});

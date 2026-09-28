/*
 * No production exports. Tests protect reloadable static resolution without listener ownership.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
import StaticHttpRequestController from "./StaticHttpRequestController.ts";

test("starts and closes independently from a socket", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-static-controller-");
  const root = temporary.path;
  await writeFile(path.join(root, "index.html"), "ready", "utf8");
  const controller = new StaticHttpRequestController({ rootDirectoryPath: root });
  await controller.start();
  controller.close();
  await assert.rejects(
    controller.handleRequest({ headers: {}, method: "GET", url: "/" } as IncomingMessage, {} as ServerResponse),
    /not running/u,
  );
});

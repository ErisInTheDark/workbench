/*
 * No production exports. Node tests protect explicit current-generation project-catalog ownership across a stable Codex bridge. Keywords: codex, project, catalog, reload, ownership, test.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEndpointProjectResolution } from "../lib/workbench/project/agent-endpoint-project";
import type CodexAppServer from "./CodexAppServer";
import CodexStdioBridge from "./CodexStdioBridge";

function createResolution(projectId: string, cwd: string): AgentEndpointProjectResolution {
  const rootPath = `C:/projects/${projectId}`;
  return {
    cwd,
    project: {
      id: projectId,
      kind: "git",
      root: rootPath,
      rootPath,
      roots: [{ id: projectId, name: projectId, root: rootPath, rootPath }],
    },
    root: { id: projectId, name: projectId, root: rootPath, rootPath },
  };
}

test("stable Codex bridge resolves subagent projects through the current catalog owner", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-codex-project-catalog-"));
  const resolvedBy: string[] = [];
  const createOwner = (projectId: string) => ({
    resolveAgentEndpointProjectFromCwd: async (cwd: string | null | undefined) => {
      assert.ok(cwd);
      resolvedBy.push(projectId);
      return createResolution(projectId, cwd);
    },
  });
  let currentOwner = createOwner("alpha");
  const bridge = new CodexStdioBridge({
    appServer: { send: () => undefined } as unknown as CodexAppServer,
    bridgeUrl: "ws://127.0.0.1:4500",
    onNotification: () => undefined,
    resolveProjectFromCwd: async (cwd) => await currentOwner.resolveAgentEndpointProjectFromCwd(cwd),
    sendToClient: () => undefined,
    storageRoot,
  });

  await bridge.handleBridgeRequest({ id: "before-reload", method: "workbench/subagent/list", params: { cwd: "C:/projects/alpha" } });
  currentOwner = createOwner("beta");
  await bridge.handleBridgeRequest({ id: "after-reload", method: "workbench/subagent/list", params: { cwd: "C:/projects/beta" } });

  assert.deepEqual(resolvedBy, ["alpha", "beta"]);
  await bridge.disposeImmediately();
});

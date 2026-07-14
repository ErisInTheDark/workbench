/*
 * Exports:
 * - No production exports; Node tests cover cwd-owned agent CLI help audience classification. Keywords: agent, cli, help, capabilities, collaboration, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkbenchAgentCliCapabilities } from "./route";

test("classifies persisted Collaboration run threads without duplicating role state", async () => {
  const resolvedProjects: string[] = [];
  const readProjects: string[] = [];
  const dependencies = {
    readCollaborationRunThreadIds: async (projectId: string) => {
      readProjects.push(projectId);
      return ["collaborator-thread"];
    },
    resolveProjectIdFromCwd: async (cwd: string) => {
      resolvedProjects.push(cwd);
      return "project-1";
    },
  };

  assert.deepEqual(await resolveWorkbenchAgentCliCapabilities({
    cwd: "C:/projects/example",
    threadId: "collaborator-thread",
  }, dependencies), { helpAudience: "collaborator" });
  assert.deepEqual(await resolveWorkbenchAgentCliCapabilities({
    cwd: "C:/projects/example",
    threadId: "ordinary-thread",
  }, dependencies), { helpAudience: "default" });
  assert.deepEqual(resolvedProjects, ["C:/projects/example", "C:/projects/example"]);
  assert.deepEqual(readProjects, ["project-1", "project-1"]);
});

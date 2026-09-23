/*
 * No production exports. Protect first-turn admission against duplicate and ambiguous dispatch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadLaunchRequestSchema, type WorkbenchThreadLaunchState } from "workbench-shared/workbench/thread/thread-launch";
import WorkbenchThreadLaunchController from "./WorkbenchThreadLaunchController";
import { WorkbenchThreadCreationNotDispatchedError } from "./WorkbenchThreadActionController";

const launchId = "dc085242-b595-4a51-9bd0-099013ead304";
const projectId = ProjectIdSchema.parse("3ffed8c7-5098-4ced-9f6a-32f13eb747c6");
const request = WorkbenchThreadLaunchRequestSchema.parse({
  launchId, projectId, clientMessageId: "message-1",
  firstInput: [{ type: "text", text: "hello", text_elements: [] }],
  profile: { kind: "custom", settings: {
    agentPath: null, agentSource: null, harness: "codex", model: "test",
    reasoningEffort: null, serviceTier: null,
  } },
});

function fixture({ failMessage = false, failBeforeCreation = false, unavailableProject = false, initial }: {
  failMessage?: boolean; failBeforeCreation?: boolean; unavailableProject?: boolean;
  initial?: WorkbenchThreadLaunchState;
} = {}) {
  let state: WorkbenchThreadLaunchState = initial ?? { phase: "prepared", launchId };
  let recorded = initial !== undefined;
  const location = { rootPath: "/repo", roots: ["/repo"] };
  let creations = 0;
  let messages = 0;
  const warnings: string[] = [];
  const controller = new WorkbenchThreadLaunchController({
    database: {
      reserveThreadLaunch: async (_input, captured) => {
        assert.deepEqual(captured, location);
        recorded = true;
        return state;
      },
      readThreadLaunch: async () => recorded ? { request, location, state } : null,
      advanceThreadLaunch: async (_id, from, next) => {
        assert.equal(state.phase, from);
        state = next;
        return state;
      },
    },
    projects: { resolveProjectById: async () => {
      if (unavailableProject) throw new Error("checkout is unavailable");
      return {
        id: projectId, kind: "git", root: "/repo", rootPath: "/repo",
        roots: [{ id: "repo", name: "repo", relativePath: ".", root: "/repo", rootPath: "/repo" }],
      };
    } },
    actions: {
      createForLaunch: async (_input, recordedLaunchId, captured) => {
        assert.equal(recordedLaunchId, launchId);
        assert.deepEqual(captured, location);
        if (failBeforeCreation) throw new WorkbenchThreadCreationNotDispatchedError("Profile is unavailable.");
        creations += 1;
        state = { phase: "created", launchId, threadId: "thread-1" };
        return { id: "thread-1" } as never;
      },
      handle: async (method) => {
        if (method === "thread/message/submit") {
          messages += 1;
          if (failMessage) throw new Error("provider outcome missing");
          return { kind: "started", turn: { id: "turn-1", items: [], status: "inProgress" } } as never;
        }
        throw new Error("Unexpected action");
      },
    },
    warn: message => warnings.push(message),
  });
  return { controller, get state() { return state; }, get creations() { return creations; }, get messages() { return messages; }, warnings };
}

test("replaying an accepted launch returns the same thread and never repeats native work", async () => {
  const owner = fixture();
  assert.deepEqual(await owner.controller.launch(request), {
    phase: "accepted", launchId, threadId: "thread-1", turnId: "turn-1",
  });
  assert.equal((await owner.controller.launch(request)).phase, "accepted");
  assert.equal(owner.creations, 1);
  assert.equal(owner.messages, 1);
});

test("an accepted launch replays even when its concrete checkout is currently unavailable", async () => {
  const owner = fixture({ unavailableProject: true, initial: {
    phase: "accepted", launchId, threadId: "thread-1", turnId: "turn-1",
  } });
  assert.equal((await owner.controller.launch(request)).phase, "accepted");
});

test("a definite pre-dispatch failure is not reported as an unknowable provider outcome", async () => {
  const owner = fixture({ failBeforeCreation: true });
  assert.deepEqual(await owner.controller.launch(request), {
    phase: "failed", launchId, reason: "Profile is unavailable.",
  });
  assert.equal((await owner.controller.launch(request)).phase, "failed");
  assert.equal(owner.creations, 0);
  assert.equal(owner.messages, 0);
});

test("uncertain first input is recorded and cannot be resent by replay", async () => {
  const owner = fixture({ failMessage: true });
  const first = await owner.controller.launch(request);
  assert.equal(first.phase, "unknown");
  assert.equal((await owner.controller.launch(request)).phase, "unknown");
  assert.equal(owner.creations, 1);
  assert.equal(owner.messages, 1);
  assert.equal(owner.warnings.length, 1);
});

test("a retained created thread sends only its still-unstarted first input", async () => {
  const owner = fixture({ initial: { phase: "created", launchId, threadId: "thread-1" } });
  assert.equal((await owner.controller.launch(request)).phase, "accepted");
  assert.equal(owner.creations, 0);
  assert.equal(owner.messages, 1);
});

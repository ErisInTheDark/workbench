/*
 * No production exports. Protect immutable launch admission and durable unknown outcomes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchProjectRepository from "../project/WorkbenchProjectRepository";
import { NativeThreadIdSchema, ProjectIdentityKeySchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchThreadLaunchRequestSchema } from "workbench-shared/workbench/thread/thread-launch";
import WorkbenchThreadLaunchRepository from "./WorkbenchThreadLaunchRepository";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";

test("one launch id retains its immutable intent and never reopens dispatched creation", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    const key = ProjectIdentityKeySchema.parse("remote://example.test/project");
    const projectId = new WorkbenchProjectRepository(database).reconcile({
      aliases: [], complete: true, discoveryRoots: [], excludedRootPaths: [], observedKeys: [key], rootPath: "/",
      data: [{
        identityKey: key, kind: "git", name: "project", relativePath: "project", rootPath: "/project",
        lastCommitTimeMs: null,
        roots: [{ id: "project", isPrimary: true, identityKey: key, name: "project", relativePath: "project", rootPath: "/project" }],
      }],
    }).catalog[0]!.project.id;
    const request = WorkbenchThreadLaunchRequestSchema.parse({
      launchId: "dc085242-b595-4a51-9bd0-099013ead304",
      projectId: ProjectIdSchema.parse(projectId),
      profile: {
        kind: "custom",
        settings: {
          agentPath: null, agentSource: null, harness: "codex", model: "test-model",
          reasoningEffort: null, serviceTier: null,
        },
      },
      firstInput: [{ type: "text", text: "hello", text_elements: [] }],
      clientMessageId: "message-one",
    });
    const repository = new WorkbenchThreadLaunchRepository(database);
    const location = { rootPath: "/project", roots: ["/project"] };
    assert.equal(repository.reserve(request, location).phase, "prepared");
    assert.equal(repository.reserve(request, location).phase, "prepared");
    assert.equal(repository.reserve(request, { rootPath: "/changed", roots: ["/changed"] }).phase, "prepared");
    assert.deepEqual(repository.read(request.launchId)?.location, location,
      "a repeated launch cannot retarget its captured roots");
    assert.throws(() => repository.reserve({ ...request, clientMessageId: "different" }, location), /different saved intent/u);
    assert.equal(repository.advance(request.launchId, "prepared", { phase: "creating", launchId: request.launchId }).phase, "creating");
    new WorkbenchThreadLaunchRepository(database).recoverInterrupted();
    const retained = new WorkbenchThreadLaunchRepository(database).read(request.launchId);
    assert.equal(retained?.state.phase, "unknown");
    assert.equal(retained?.request.clientMessageId, "message-one");
    assert.equal(repository.reserve(request, location).phase, "unknown");
    assert.throws(() => repository.advance(request.launchId, "prepared", { phase: "creating", launchId: request.launchId }),
      /changed before settlement/u);
  } finally { database.close(); }
});

test("an interrupted first send settles only from delivered matching client-message evidence", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const launchId = "76f3f1e1-c1a0-4f87-b990-d6ecfa5ccf24";
  const projectId = ProjectIdSchema.parse("00000000-0000-4000-8000-000000000001");
  try {
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(projectId);
    const repository = new WorkbenchThreadLaunchRepository(database);
    const request = WorkbenchThreadLaunchRequestSchema.parse({
      launchId, projectId, clientMessageId: "first-message",
      profile: { kind: "custom", settings: {
        agentPath: null, agentSource: null, harness: "codex", model: "test",
        reasoningEffort: null, serviceTier: null,
      } },
      firstInput: [{ type: "text", text: "hello", text_elements: [] }],
    });
    repository.reserve(request, { rootPath: "/repo", roots: ["/repo"] });
    repository.advance(launchId, "prepared", { phase: "creating", launchId });
    const thread = new WorkbenchThreadIdentityRepository(database).observe({
      launchId, projectId, projectRoot: "/repo", title: "new",
      native: { harness: "codex", nativeLocation: "/repo", nativeThreadId: NativeThreadIdSchema.parse("native-thread") },
      createdAt: 1, updatedAt: 1, activityAt: 1,
    });
    repository.advance(launchId, "created", { phase: "sending", launchId, threadId: thread.threadId });
    repository.recoverInterrupted();
    assert.equal(repository.read(launchId)?.state.phase, "unknown");
    const turnId = "9e3849ef-b99f-4915-883c-06df269683b9";
    database.prepare(`INSERT INTO thread_turns
      (id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
      VALUES (?, ?, 0, 'codex', '/repo', 'native-thread', 'inProgress', 1)`)
      .run(turnId, thread.threadId);
    const itemId = "96ab31af-006d-4862-98c0-b72cb32781c8";
    database.prepare(`INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)`)
      .run(itemId, thread.threadId);
    const item = database.prepare(`INSERT INTO thread_items
      (public_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'userMessage', 1, 1)`)
      .run(itemId, thread.threadId, turnId);
    database.prepare(`INSERT INTO thread_item_user_messages
      (item_id, delivery_state, client_id, error_text) VALUES (?, 'failed', 'first-message', 'provider failed')`)
      .run(item.lastInsertRowid);
    assert.equal(repository.read(launchId)?.state.phase, "unknown");
    database.prepare(`UPDATE thread_item_user_messages SET delivery_state = 'delivered', error_text = NULL
      WHERE item_id = ?`).run(item.lastInsertRowid);
    assert.deepEqual(repository.read(launchId)?.state, {
      phase: "accepted", launchId, threadId: thread.threadId, turnId,
    });
  } finally { database.close(); }
});

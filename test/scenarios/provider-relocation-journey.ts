/*
 * Exports:
 * - runProviderRelocation: one real provider's thread survives its checkout moving: the vanished project merges into a
 *   same-remote clone, and the next turn runs there through the provider's own native session, without a duplicate thread.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type { WorkbenchComposerProfileTargetSelection } from "../../shared/types";
import { WORKBENCH_TURN_END_MARKER } from "../../shared/workbench/thread/thread-recovery-message";
import { CLAUDE_COMMENTARY_HINT } from "../../daemon/server/providers/claude/ClaudeCommentaryNudge";
import { nativeLocationKey } from "../../daemon/server/database/thread-identity/native-location-key";
import IsolatedWorkbench from "./IsolatedWorkbench";
import type FakeThreadModelServer from "./FakeThreadModelServer";
import type { FakeThreadAction } from "./FakeThreadModelServer";
import ProviderThreadJourney from "./ProviderThreadJourney";
import { fakeOpenCodeDirectTool } from "./provider-boundary-journey";

type Provider = "codex" | "opencode" | "claude";

/** The shortest scripted turn each provider accepts as completed, quoting `proof`. */
function completedTurn(provider: Provider, proof: string): FakeThreadAction[] {
  if (provider === "codex") return [{ tool: { nameSuffix: "task_completed", arguments: {} } }, { text: proof }];
  // OpenCode samples again after the completion tool's result; an empty answer ends its loop, as in the shared final turn.
  if (provider === "opencode") return [fakeOpenCodeDirectTool("task_completed", {}, proof), { text: "" }];
  return [
    { text: proof, tool: { nameSuffix: "task_completed", arguments: {} } },
    { text: "Done.", bare: true },
    { text: WORKBENCH_TURN_END_MARKER, bare: true, requiredPromptText: [CLAUDE_COMMENTARY_HINT] },
  ];
}

function readDatabase<T>(file: string, read: (database: Database.Database) => T) {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try { return read(database); } finally { database.close(); }
}

export async function runProviderRelocation(input: {
  runtime: IsolatedWorkbench;
  provider: Provider;
  selection: WorkbenchComposerProfileTargetSelection;
  fakeModel: FakeThreadModelServer;
  signal: AbortSignal;
}) {
  const { runtime, provider, selection, fakeModel, signal } = input;
  const step = (label: string) => runtime.markPhase(`${provider} relocation: ${label}`);
  const projects = path.dirname(runtime.project);
  const oldRoot = path.join(projects, `relocate-${provider}-old`);
  const newRoot = path.join(projects, `relocate-${provider}-new`);
  const remote = `https://example.invalid/workbench/relocate-${provider}.git`;
  const git = (args: string[], cwd: string) => IsolatedWorkbench.command("git", args, cwd, process.env, signal);
  const workbenchDatabase = path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3");
  const nativeSession = (threadId: string) => readDatabase(workbenchDatabase, database =>
    database.prepare("SELECT native_thread_id FROM thread_turns WHERE thread_id = ? LIMIT 1").pluck().get(threadId) as string);
  const threadProject = (threadId: string) => readDatabase(workbenchDatabase, database =>
    (database.prepare("SELECT project_id FROM workbench_threads WHERE id = ?").get(threadId) as { project_id: string } | undefined)?.project_id);

  step("creating the original checkout");
  await fs.mkdir(oldRoot, { recursive: true });
  await fs.writeFile(path.join(oldRoot, "README.md"), `relocation fixture for ${provider}\n`);
  // The same managed instructions as the shared fixture, which fake models require on every request.
  await fs.copyFile(path.join(runtime.project, "AGENTS.md"), path.join(oldRoot, "AGENTS.md"));
  await git(["init", "-q"], oldRoot);
  await git(["remote", "add", "origin", remote], oldRoot);
  await git(["add", "."], oldRoot);
  await git(["-c", "user.name=Workbench Scenario", "-c", "user.email=scenario@workbench.invalid",
    "commit", "-qm", "relocation fixture"], oldRoot);
  const original = (await runtime.waitForProjects([oldRoot], signal))
    .find(project => nativeLocationKey(project.rootPath) === nativeLocationKey(oldRoot));
  assert.ok(original, "The original checkout must be catalogued");

  step("running a turn at the original checkout");
  const firstProof = `relocation-first-${randomUUID()}`;
  fakeModel.enqueue(completedTurn(provider, firstProof));
  const threadId = await runtime.launchDraft(original.id, selection, `Reply with exactly ${firstProof}.`);
  const before = new ProviderThreadJourney(runtime, provider, original.id, threadId, signal);
  // Durable waits re-read on transcript events, which reach only subscribed threads.
  await before.subscribe();
  const firstTurn = (await runtime.daemon.threads.page({ threadId, cursor: null })).thread.turns.at(-1)?.id;
  assert.ok(firstTurn, "The launch must admit its first turn");
  await before.waitTurn(firstTurn);
  let primaryFailure: unknown = null;
  try {
    step("moving the checkout to a same-remote clone");
    await git(["clone", "-q", oldRoot, newRoot], projects);
    await git(["remote", "set-url", "origin", remote], newRoot);
    const moved = (await runtime.waitForProjects([newRoot], signal))
      .find(project => nativeLocationKey(project.rootPath) === nativeLocationKey(newRoot));
    assert.ok(moved, "The clone must be catalogued");
    await fs.rm(oldRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

    step("waiting for the vanished project to merge into the clone");
    let scans = 0;
    await runtime.waitForFact(async () => {
      // Each new folder is a watcher event, so every wait ends in another complete scan.
      await fs.mkdir(path.join(projects, `.relocation-scan-${provider}-${scans++}`));
      return threadProject(threadId);
    }, projectId => projectId === moved.id, signal);

    step("continuing the merged thread");
    const after = new ProviderThreadJourney(runtime, provider, moved.id, threadId, signal);
    const secondProof = `relocation-second-${randomUUID()}`;
    fakeModel.enqueue(completedTurn(provider, secondProof));
    const secondTurn = await after.submit(`Reply with exactly ${secondProof}.`, "newTurn");
    await after.waitTurn(secondTurn);
    // Workbench settles the turn at task completion; the provider may still be sampling its closing step.
    await after.waitProviderIdle();
    if (fakeModel.queuedActions) {
      const turn = (await after.durable()).turns.find(candidate => candidate.id === secondTurn);
      assert.fail(`${provider} left ${fakeModel.queuedActions} scripted step(s) after the moved turn: ${JSON.stringify({
        status: turn?.status, items: turn?.items.map(item => ({ type: item.type, status: "status" in item ? item.status : undefined,
          text: "text" in item ? String(item.text).slice(0, 120) : undefined })),
        modelFailure: fakeModel.lastFailure?.message,
        native: provider === "opencode" ? readDatabase(path.join(runtime.root, "data", "opencode", "opencode.db"), database =>
          (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all() as string[]).flatMap(table => {
            const columns = (database.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name);
            const column = columns.find(name => name === "session_id" || name === "sessionID");
            if (!column) return [];
            return (database.prepare(`SELECT * FROM "${table}" WHERE "${column}" = ?`).all(nativeSession(threadId)) as unknown[])
              .map(row => `${table}: ${JSON.stringify(row).slice(0, 400)}`);
          })) : undefined,
      })}`);
    }

    const threads = readDatabase(workbenchDatabase, database => database.prepare(`
      SELECT thread.id FROM workbench_threads thread
      JOIN workbench_top_level_thread_states placement ON placement.thread_id = thread.id
      WHERE thread.project_id = ?
    `).pluck().all(moved.id) as string[]);
    assert.deepEqual(threads, [threadId], "The merged project must hold the moved thread once, with no duplicate");
    const latest = readDatabase(workbenchDatabase, database => database.prepare(`
      SELECT native_location, native_thread_id FROM thread_turns WHERE thread_id = ? ORDER BY turn_index DESC LIMIT 1
    `).get(threadId) as { native_location: string; native_thread_id: string });
    assert.equal(nativeLocationKey(latest.native_location), nativeLocationKey(newRoot),
      "The provider must report the continued turn at the clone");
    if (provider === "codex") {
      const thread = await runtime.daemon.threads.page({ threadId, cursor: null });
      assert.equal(nativeLocationKey(thread.thread.cwd), nativeLocationKey(newRoot), "Codex must report the clone as its cwd");
    } else if (provider === "opencode") {
      const row = readDatabase(path.join(runtime.root, "data", "opencode", "opencode.db"), database =>
        database.prepare("SELECT * FROM session_v2 WHERE id = ?").get(latest.native_thread_id));
      assert.ok(row && JSON.stringify(row).replaceAll("\\\\", "/").toLowerCase()
        .includes(newRoot.replaceAll("\\", "/").toLowerCase()), "OpenCode must have moved its session to the clone");
    } else {
      const log = path.join(runtime.root, "claude", "projects", newRoot.replace(/[^A-Za-z0-9]/gu, "-"), `${latest.native_thread_id}.jsonl`);
      assert.ok((await fs.readFile(log, "utf8")).includes(secondProof), "Claude must resume the session from the clone");
    }
    step("verified");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await before.unsubscribe();
      await runtime.daemon.threads.stop({ threadId, intent: "stop" });
      // A merged thread keeps one native binding, so deleting its session stays unambiguous.
      await runtime.daemon.threads.deleteProvider({ threadId });
    } catch (cleanupError) {
      if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError], `${provider} relocation and its cleanup failed.`);
      throw cleanupError;
    }
  }
}

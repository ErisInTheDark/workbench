/*
 * Keywords: retained database, startup replay, identity upgrade, isolated copy, recovery evidence.
 * No exports. Explicit non-paid replay upgrades only a private backup of the selected database.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../daemon/orchestrator/database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../daemon/orchestrator/database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptRepository from "../daemon/orchestrator/database/transcript/WorkbenchTranscriptRepository";
import { projectWorkbenchTranscript } from "../shared/workbench/transcript/workbench-transcript-projection";
import CodexTranscriptStore from "../daemon/orchestrator/CodexTranscriptStore";
import WorkbenchThreadIdentityController from "../daemon/orchestrator/WorkbenchThreadIdentityController";
import WorkbenchTranscriptIdentityController from "../daemon/orchestrator/WorkbenchTranscriptIdentityController";
import WorkbenchTranscriptIdentityRepository from "../daemon/orchestrator/database/transcript/WorkbenchTranscriptIdentityRepository";
import { admitProviderThreads, mapProviderThread } from "../daemon/orchestrator/thread-identity-provider-mapping";
import { admitNativeTranscriptObservations, mapNativeTranscriptObservation } from "../daemon/orchestrator/thread-identity-transcript-mapping";
import { createCodexTranscriptSqliteImport } from "../daemon/orchestrator/codex-transcript-sqlite-import";
import { createCodexTranscriptProviderTurnScopeObservation } from "../daemon/orchestrator/codex-transcript-provider-observations";
import { mapNativeProviderResponse } from "../daemon/orchestrator/thread-identity-workbench-mapping";

const input = process.env.WORKBENCH_REPLAY_DATABASE;

test("retained database upgrades and resolves existing identities without modifying its source", {
  skip: !input,
}, async () => {
  assert.ok(input);
  const sourcePath = await fs.realpath(input);
  const workspace = path.resolve(process.cwd(), "..");
  const recoveryRoot = path.join(workspace, ".workbench", "recovery");
  const relative = path.relative(recoveryRoot, sourcePath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Replay accepts a preserved recovery snapshot, never the live database");
  const digest = async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
    return hash.digest("hex");
  };
  const before = await digest();
  const output = path.join(workspace, ".workbench", "diagnostics", `state-replay-${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const target = path.join(output, "candidate.sqlite3");
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(target);
  } finally {
    source.close();
  }
  let database: Database.Database | null = new Database(target, { fileMustExist: true });
  const report: { stage: string; source: string; output: string; resolved: number; projected: number; metadataOnly: number; error?: string } = {
    stage: "copied", source: sourcePath, output, resolved: 0, projected: 0, metadataOnly: 0,
  };
  try {
    database.pragma("foreign_keys = ON");
    report.stage = "schema upgrade";
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const repository = new WorkbenchThreadIdentityRepository(database);
    report.stage = "cold identity admission";
    repository.list();
    const references = database.prepare("SELECT id, project_id FROM workbench_threads ORDER BY id")
      .all() as Array<{ id: string; project_id: string }>;
    const admitted = [];
    for (const row of references) {
      const identity = repository.resolve({ threadId: row.id, projectId: row.project_id });
      assert.ok(identity, "Every retained thread must retain its canonical identity");
      assert.equal(identity.projectId, row.project_id);
      admitted.push({ reference: row.id, projectId: row.project_id, threadId: identity.threadId });
      report.resolved++;
    }
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    database.close();
    database = new Database(target, { fileMustExist: true });
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    const reopened = new WorkbenchThreadIdentityRepository(database);
    reopened.list();
    report.stage = "cold reopen";
    for (const row of admitted) {
      assert.equal(reopened.resolve({ threadId: row.reference, projectId: row.projectId })?.threadId, row.threadId);
    }
    report.stage = "retained transcript projection";
    const transcripts = new WorkbenchTranscriptRepository(database);
    for (const row of admitted) {
      const materialized = database.prepare(`
        SELECT t.id FROM thread_turns t JOIN thread_turn_materializations m ON m.turn_id = t.id
        WHERE t.thread_id = ? ORDER BY t.turn_index DESC LIMIT 1
      `).get(row.threadId) as { id: string } | undefined;
      if (!materialized) {
        report.metadataOnly++;
        continue;
      }
      const snapshot = transcripts.read({ threadId: row.threadId, turnLimit: 1, turnIds: [materialized.id] });
      assert.ok(snapshot, `Retained transcript root missing for ${row.threadId}`);
      const projection = projectWorkbenchTranscript(snapshot);
      assert.ok(projection.success, `Retained transcript cannot project for ${row.threadId}`);
      report.projected++;
    }
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    report.stage = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    database?.close();
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    assert.equal(await digest(), before, "The preserved source must remain byte-identical");
    console.log(`Retained-data replay evidence: ${output}`);
  }
});

for (const settlement of ["compatibility", "provider"] as const) {
test(`retained history imports and projects repeatedly through ${settlement} settlement`, {
  skip: !process.env.WORKBENCH_REPLAY_HISTORY,
}, async () => {
  const workspace = path.resolve(process.cwd(), "..");
  const source = await fs.realpath(process.env.WORKBENCH_REPLAY_HISTORY!);
  const relative = path.relative(path.join(workspace, ".workbench", "recovery"), source);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8")) as {
    threadId: string; turnIds: string[]; projectId: string; projectRoot: string;
  };
  const output = path.join(workspace, ".workbench", "diagnostics", `history-replay-${randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const transcriptPath = path.join(".workbench", "transcripts", "codex", "threads",
    Buffer.from(manifest.threadId).toString("base64url"));
  await fs.mkdir(path.join(output, transcriptPath, "turns"), { recursive: true });
  for (const file of ["thread.json", ...manifest.turnIds.map((id) => path.join("turns", `${Buffer.from(id).toString("base64url")}.json`))]) {
    const original = await fs.realpath(path.join(source, transcriptPath, file));
    const sourceRelative = path.relative(source, original);
    assert.ok(sourceRelative && !sourceRelative.startsWith("..") && !path.isAbsolute(sourceRelative),
      "History replay cannot follow a source link outside its preserved input");
    await fs.copyFile(original, path.join(output, transcriptPath, file));
  }
  const target = path.join(output, "candidate.sqlite3");
  if (input) {
    const preserved = await fs.realpath(input);
    const databaseRelative = path.relative(path.join(workspace, ".workbench", "recovery"), preserved);
    assert.ok(databaseRelative && !databaseRelative.startsWith("..") && !path.isAbsolute(databaseRelative));
    const sourceDatabase = new Database(preserved, { readonly: true, fileMustExist: true });
    try { await sourceDatabase.backup(target); } finally { sourceDatabase.close(); }
  }
  const database = new Database(target);
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const repository = new WorkbenchThreadIdentityRepository(database);
  const itemRepository = new WorkbenchTranscriptIdentityRepository(database);
  const timings: Record<string, { calls: number; milliseconds: number }> = {};
  const measure = async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await operation(); } finally {
      const timing = timings[name] ??= { calls: 0, milliseconds: 0 };
      timing.calls++;
      timing.milliseconds += performance.now() - start;
    }
  };
  const threads = new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => repository.list(),
    observeThreadIdentities: (rows) => measure("thread identity", () => repository.observeMany(rows)),
    resolveThreadIdentity: async (row) => repository.resolve(row),
    resolveNativeThreadIdentity: async (row) => repository.resolveNative(row),
    observeTurnIdentities: (rows) => measure("turn identity", () => repository.observeTurns(rows)),
    resolveTurnIdentity: async (row) => repository.resolveTurn(row),
  });
  const items = new WorkbenchTranscriptIdentityController({
    admitTranscriptItemIdentities: (rows) => measure("item identity", () => itemRepository.admitMany(rows)),
    resolveTranscriptItemIdentity: async (row) => itemRepository.resolve(row),
  });
  const store = new CodexTranscriptStore(output, () => [manifest.threadId]);
  const report: { stage: string; timings: typeof timings; items?: number; error?: string } = { stage: "hydrate copied history", timings };
  try {
    await threads.start();
    const thread = await measure("stored window", () => store.readStoredThreadWindow(manifest.threadId, manifest.turnIds));
    assert.ok(thread);
    assert.deepEqual(new Set(thread.turns.map(({ id }) => id)), new Set(manifest.turnIds));
    const native = { harness: "codex", nativeLocation: thread.cwd, nativeThreadId: thread.id };
    const owners = { threads, items };
    const context = {
      projectId: manifest.projectId, projectRoot: manifest.projectRoot, nativeLocation: thread.cwd,
      title: thread.name ?? "", createdAt: thread.createdAt * 1_000,
      updatedAt: thread.updatedAt * 1_000, activityAt: thread.updatedAt * 1_000,
    };
    const entries = await store.readThreadContextEntries(thread.id, { turnIds: manifest.turnIds });
    const transcript = new WorkbenchTranscriptRepository(database);
    let priorItemIds: string[] | null = null;
    for (let pass = 0; pass < 2; pass++) {
      report.stage = `provider admission ${pass}`;
      await measure(`provider admission ${pass}`, () => admitProviderThreads(owners, [{ metadata: { ...context, native }, thread }]));
      report.stage = `page context admission ${pass}`;
      await admitNativeTranscriptObservations(owners, [
        ...entries.questionnaireEntries.map((entry) => ({ kind: "questionnaire" as const, entry, observedAt: entry.resolvedAt })),
        ...entries.steerEntries.map((entry) => ({ kind: "steer" as const, entry, observedAt: entry.resolvedAt ?? entry.attemptedAt })),
      ]);
      report.stage = `full page response ${pass}`;
      const page = await measure(`page response ${pass}`, () => mapNativeProviderResponse(owners, "codex", {
        method: "workbench/thread/page/read", params: { threadId: thread.id, cursor: null },
      }, { id: 1, result: { ...entries, thread, nextCursor: null } }));
      assert.ok(page.result);
      report.stage = `${settlement} settlement ${pass}`;
      if (settlement === "provider") {
        for (const turn of thread.turns) {
          const scope = createCodexTranscriptProviderTurnScopeObservation({ context, threadId: thread.id, turn });
          await admitNativeTranscriptObservations(owners, [scope]);
          const mappedScope = mapNativeTranscriptObservation(owners, native, scope);
          await measure(`provider settlement ${pass}`, () => transcript.settle([mappedScope]));
        }
      } else {
        const observation = createCodexTranscriptSqliteImport({
          ...entries, context, thread, browseAssets: new Map(),
        });
        await admitNativeTranscriptObservations(owners, [observation]);
        const mapped = mapNativeTranscriptObservation(owners, native, observation);
        await measure(`body settlement ${pass}`, () => transcript.settle([mapped]));
      }
      report.stage = `public projection ${pass}`;
      const publicThread = mapProviderThread(owners, native, thread);
      const snapshot = transcript.read({ threadId: publicThread.id, turnLimit: manifest.turnIds.length,
        turnIds: publicThread.turns.map(({ id }) => id) });
      assert.ok(snapshot);
      const projection = projectWorkbenchTranscript(snapshot);
      assert.ok(projection.success);
      const itemIds = publicThread.turns.flatMap((turn) => turn.items.map(({ id }) => id));
      if (priorItemIds) assert.deepEqual(itemIds, priorItemIds);
      priorItemIds = itemIds;
      report.items = itemIds.length;
    }
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    report.stage = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    await store.dispose();
    threads.dispose();
    items.dispose();
    database.close();
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Retained-history replay evidence: ${output}`);
  }
});
}

/*
 * Exports:
 * - installLifecycleProbe: instrument only a private copy's node lifecycle callbacks.
 * - writeLifecycleFault: select held drain or failed activation for the next transition.
 * - appendLifecycleMigration: append a synthetic release without changing sealed production history.
 * - seedLifecycleTranscript: admit an isolated durable transcript and image without JSON recording.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { NativeThreadIdSchema, NativeTurnIdSchema, ProjectIdSchema } from "../shared/workbench/identity";
import WorkbenchThreadIdentityRepository from "../daemon/orchestrator/database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchTranscriptIdentityRepository from "../daemon/orchestrator/database/transcript/WorkbenchTranscriptIdentityRepository";
import WorkbenchTranscriptRepository from "../daemon/orchestrator/database/transcript/WorkbenchTranscriptRepository";
import externalizeCodexTranscriptInlineImages from "../daemon/orchestrator/codex-transcript-image-assets";

export async function seedLifecycleTranscript(project: string) {
  const database = new Database(path.join(project, ".workbench/workbench.sqlite3"), { fileMustExist: true });
  database.pragma("foreign_keys = ON");
  try {
    const threads = new WorkbenchThreadIdentityRepository(database);
    const nativeThreadId = NativeThreadIdSchema.parse("lifecycle-transcript");
    const thread = threads.observe({
      native: { harness: "codex", nativeLocation: project, nativeThreadId },
      projectId: ProjectIdSchema.parse("lifecycle"), projectRoot: project,
      title: "isolated transcript", createdAt: 1, updatedAt: 2, activityAt: 2,
    });
    const turn = threads.observeTurn({
      kind: "turn", turnId: NativeTurnIdSchema.parse("lifecycle-turn"),
      threadId: thread.threadId, harnessId: "codex", nativeLocation: project,
      nativeThreadId, nativeTurnId: NativeTurnIdSchema.parse("lifecycle-turn"),
      state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
    });
    const item = new WorkbenchTranscriptIdentityRepository(database).admit({
      threadId: thread.threadId, sources: [{ turnId: turn.turnId, sourceId: "image", kind: "stable" }], legacyAliases: [],
    });
    const bytes = Buffer.from("isolated transcript image");
    const image = await externalizeCodexTranscriptInlineImages({
      type: "image" as const, url: `data:image/png;base64,${bytes.toString("base64")}`,
    }, { storageRoot: project, threadId: nativeThreadId });
    new WorkbenchTranscriptRepository(database).settle([{
      kind: "providerTurnScope", threadId: thread.threadId, completeTurnIds: [turn.turnId],
      observations: [{
        kind: "turn", threadId: thread.threadId, turnId: turn.turnId, turnIndex: turn.turnIndex,
        harnessId: "codex", nativeLocation: project, nativeThreadId,
        nativeTurnId: NativeTurnIdSchema.parse("lifecycle-turn"),
        state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
      }, {
        kind: "item", threadId: thread.threadId, turnId: turn.turnId, publicItemId: item.itemId,
        lifecycle: "completed", observedAt: 2,
        item: { id: "image", type: "userMessage", clientId: null, content: [image.value] },
      }],
    }, {
      kind: "providerCursor", threadId: thread.threadId, turnId: turn.turnId, previousCursor: null,
    }]);
    return { threadId: thread.threadId, turnId: turn.turnId, itemId: item.itemId, bytes };
  } finally { database.close(); }
}

async function replaceOnce(file: string, before: string, after: string) {
  const source = await fs.readFile(file, "utf8");
  assert.equal(source.split(before).length, 2, `Fixture overlay needs one unambiguous seam in ${file}`);
  await fs.writeFile(file, source.replace(before, after));
}

export async function writeLifecycleFault(project: string, fault: {
  hold?: string; fail?: string; database?: string; table?: string; initial?: boolean;
}) {
  await fs.mkdir(path.join(project, ".workbench"), { recursive: true });
  await fs.writeFile(path.join(project, ".workbench/lifecycle-control.json"), JSON.stringify(fault));
}

export async function installLifecycleProbe(project: string) {
  await writeLifecycleFault(project, {});
  // This module exists only in the copy. It decorates real instances, not a fake graph,
  // and leaves detach/resume/checkpoint ownership with their production owners.
  await fs.writeFile(path.join(project, "shared/reload/lifecycle-probe.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Database = require("better-sqlite3");
const control = path.resolve(__dirname, "../../.workbench/lifecycle-control.json");
const instrumented = Symbol.for("workbench.lifecycle-probe");
exports.instrument = (instance, scope, mode) => {
  if (instance[instrumented]) return instance;
  instance[instrumented] = true;
  const identity = randomUUID();
  const read = () => JSON.parse(fs.readFileSync(control, "utf8"));
  const mark = (phase) => console.log("[lifecycle] " + phase + " " + scope + " " + identity);
  const dispose = instance.dispose.bind(instance);
  instance.dispose = async (report = () => {}) => {
    mark("disposing");
    await dispose((phase) => { mark("disposing " + phase); report(phase); });
    mark("disposed");
  };
  const activate = instance.activate?.bind(instance);
  instance.activate = async () => {
    await activate?.();
    if ((mode === "replacement" || read().initial) && read().fail === scope) {
      const fault = read();
      if (fault.database) {
        const database = new Database(fault.database, { readonly: true });
        try {
          if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(fault.table)) {
            throw new Error("Lifecycle fault reached before migration");
          }
          mark("migration-observed");
        } finally { database.close(); }
      }
      mark("failure");
      throw new Error("Lifecycle injected activation failure " + scope);
    }
    mark("active");
  };
  if (instance.beginHandoff) {
    const begin = instance.beginHandoff.bind(instance);
    instance.beginHandoff = (replacement) => {
      const handoff = begin(replacement);
      const held = read().hold === scope;
      return {
        ...handoff,
        waitForIdle: () => held ? new Promise(() => { mark("held"); }) : handoff.waitForIdle(),
        expire: () => { handoff.expire(); mark("expired"); },
        resume: async () => { await handoff.resume(); mark("resumed"); },
        commit: async () => { mark("committing"); await handoff.commit(); mark("committed"); },
      };
    };
  }
  return instance;
};
`);
  const node = path.join(project, "shared/reload/ReloadableNode.ts");
  await replaceOnce(node, "this.create = options.create;",
    'this.create = (context, build) => instrument(options.create(context, build), options.scope, build.mode);');
  await fs.appendFile(node, '\nimport { instrument } from "./lifecycle-probe.cjs";\n');
}

export async function appendLifecycleMigration(project: string, owner: "app" | "orchestrator", version: number) {
  const table = `lifecycle_${owner}_candidate`;
  const declaration = `
const lifecycleTable = defineTable("${table}", { value: text().primaryKey() });
const lifecycleHistory = defineTableHistory({
  current: lifecycleTable,
  versions: [tableVersion({ schemaVersion: ${version}, table: lifecycleTable, migration: createTable(lifecycleTable) })],
});
`;
  const fingerprintImport = 'import { fingerprintSchemaReleases } from "workbench-shared/database/schema/schema-release-manifest";\n';
  if (owner === "orchestrator") {
    const schema = path.join(project, "daemon/orchestrator/database/workbench-database-schema.ts");
    await fs.appendFile(schema, '\nimport { defineTable, text } from "workbench-shared/database/schema/schema-definition";\n'
      + 'import { defineSubsystemHistory, defineTableHistory, tableVersion, createTable } from "workbench-shared/database/schema/schema-history";\n'
      + fingerprintImport);
    await replaceOnce(schema, "export const workbenchDatabaseSchema =", declaration + "\nexport const workbenchDatabaseSchema =");
    await replaceOnce(schema, "subsystems: [", "subsystems: [defineSubsystemHistory([lifecycleHistory]),");
    await replaceOnce(schema, 'workbenchDatabaseSchema, databaseReleases, "orchestrator"',
      'workbenchDatabaseSchema, { ...databaseReleases, lifecycle: fingerprintSchemaReleases(workbenchDatabaseSchema).at(-1)! }, "orchestrator"');
  } else {
    const schema = path.join(project, "shared/state/workbench-app-state-schema.ts");
    await replaceOnce(schema, "const histories = [", declaration + "\nconst histories = [lifecycleHistory,");
    const repository = path.join(project, "app/state/WorkbenchAppStateRepository.ts");
    await fs.appendFile(repository, "\n" + fingerprintImport);
    await replaceOnce(repository, 'appStateSchema, appStateReleases, "app"',
      'appStateSchema, { ...appStateReleases, lifecycle: fingerprintSchemaReleases(appStateSchema).at(-1)! }, "app"');
  }
  return table;
}

/*
 * No exports. One isolated current-database lifecycle scenario, never ordinary test discovery.
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { test } from "node:test";
import Database from "better-sqlite3";
import IsolatedWorkbench from "./IsolatedWorkbench";
import { appendLifecycleMigration, installLifecycleProbe, seedLifecycleTranscript, writeLifecycleFault } from "./lifecycle-fixture";
import { captureThreadStateMigrationSource, verifyThreadStateMigrationSource, installThreadStateMigrationSource } from "./thread-state-migration-fixture";
import {
  WORKBENCH_RELOAD_METHOD, WORKBENCH_RELOAD_DIRT_READ_METHOD,
  WORKBENCH_RELOAD_DIRT_UPDATED_METHOD, WorkbenchDaemonReloadDirtEnvelopeSchema,
  type DaemonReloadResponse,
} from "../../shared/workbench/daemon-reload";
import type { WorkbenchReloadDirtSnapshot } from "../../shared/reload/workbench-reload";
import type { WorkbenchProjectsPayload } from "../../shared/types";
import { projectWorkbenchTranscript } from "../../shared/workbench/transcript/workbench-transcript-projection";
import type { TranscriptStreamUpdate } from "../../shared/workbench/transcript/thread-transcript-stream";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import { readDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint";
import { WorkbenchDaemonConnectionSchema, WorkbenchDaemonEndpointSchema } from "../../shared/http/workbench-daemon-endpoint";
import { readServiceEndpoint } from "../../shared/process/workbench-service-endpoint";
import { WorkbenchDaemonIdentitySchema } from "../../shared/http/workbench-daemon-discovery";
import WorkbenchAppStateRepository from "../../app/server/state/WorkbenchAppStateRepository";
import WorkbenchNetworkRepository from "../../daemon/host/network/WorkbenchNetworkRepository";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "../../shared/database/workbench-database-statements";
import { serviceTableInventory } from "../../shared/state/workbench-service-schema";

function inspectDatabase(file: string, table?: string) {
  const database = new Database(file, { readonly: true });
  try {
    return {
      version: database.pragma("user_version", { simple: true }) as number,
      table: table ? Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) : false,
      integrity: database.pragma("integrity_check", { simple: true }),
    };
  } finally { database.close(); }
}

test("real application survives reload expiry, migrated candidate failure, retry and cold reopening", {
  skip: process.env.WORKBENCH_LIFECYCLE_TEST_FILE !== "test/scenarios/lifecycle.scenario.test.ts",
  timeout: 600_000,
}, async (t) => {
  const runtime = await IsolatedWorkbench.create(path.resolve(process.cwd(), ".."), t.signal, { codexIdentity: false });
  console.log(`lifecycle fixture: ${runtime.root}`);
  const appDatabase = path.join(runtime.dataRootPath, "app", "app-state.sqlite3");
  const serverDatabase = path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3");
  const endpointPath = path.join(runtime.dataRootPath, "daemon", "runtime.json");
  const serviceDatabase = path.join(runtime.dataRootPath, "service", "service.sqlite3");
  const serviceIdentity = async () => {
    const endpoint = await readServiceEndpoint(path.join(runtime.dataRootPath, "service", "runtime.json"));
    assert.ok(endpoint);
    const response = await fetch(`${endpoint.origin}/_workbench-service/identity`, { signal: t.signal });
    assert.equal(response.status, 200);
    return WorkbenchDaemonIdentitySchema.parse(await response.json());
  };
  const legacyRoot = path.join(runtime.project, ".workbench/transcripts/codex");
  const retainedFile = path.join(legacyRoot, "retained-cutover-evidence.json");
  const retainedContents = '{"retained":"lifecycle cutover evidence"}';
  const runtimePath = "/api/workbench-app-runtime?version=3";
  const http = async (route: string, init?: RequestInit) => {
    const response = await fetch(new URL(route, runtime.appOrigin), {
      ...init, signal: init?.signal ? AbortSignal.any([t.signal, init.signal]) : t.signal,
    });
    assert.ok(response.ok, `App ${route}: ${response.status} ${await response.clone().text()}`);
    return response;
  };
  const appState = async () => (await http("/api/workbench-client-state")).json() as Promise<{ daemonRegistrationId: string }>;
  const verifyEndpoint = async () => {
    const endpoint = runtime.daemonEndpoint;
    assert.deepEqual(await readDaemonEndpoint(endpointPath), endpoint);
    const health = await fetch(`${endpoint.origin}/healthz`, { signal: t.signal });
    assert.deepEqual(WorkbenchDaemonEndpointSchema.parse(await health.json()), endpoint);
    // App listener readiness deliberately precedes asynchronous daemon verification.
    // Request completion yields to that observer; the scenario signal bounds failure.
    for (;;) {
      const connection = WorkbenchDaemonConnectionSchema.parse(await (await http("/api/workbench-network?connection=1")).json());
      if (connection.localPort === null) continue;
      assert.equal(connection.localPort, Number(new URL(endpoint.origin).port));
      break;
    }
  };
  const appDirt = async (signal?: AbortSignal) => (await (await http(runtimePath, { signal })).json() as { reloadDirt: WorkbenchReloadDirtSnapshot }).reloadDirt;
  const serverDirt = async () => WorkbenchDaemonReloadDirtEnvelopeSchema.parse(
    await runtime.request(WORKBENCH_RELOAD_DIRT_READ_METHOD)).snapshot;
  const clean = (dirt: Pick<WorkbenchReloadDirtSnapshot, "dirtyScopes" | "pendingScopes"> & { error?: string | null }) => {
    assert.deepEqual(dirt.pendingScopes, [], "Admission is not reload completion");
    assert.equal(dirt.error, null);
    assert.ok(!dirt.dirtyScopes.some(({ scope }) => scope.endsWith(":process")), "Reload must not manufacture process dirt");
  };
  const assets = async () => {
    const html = await (await http("/")).text();
    const urls = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gu)]
      .map((match) => match[1]);
    assert.ok(urls.some((url) => url.includes(".js")), "Cold startup must serve a compiled script");
    assert.ok(urls.some((url) => url.includes(".css")), "Cold startup must serve compiled styles");
    for (const url of urls) {
      assert.equal(new URL(url, runtime.appOrigin).origin, runtime.appOrigin, "Assets must stay in the fixture");
      assert.ok((await (await http(url)).arrayBuffer()).byteLength > 0);
    }
  };
  const reloadServer = async (scopes: string[], failure = false, all = false) => {
    // Reading registers this connection for subsequent dirt notifications.
    await serverDirt();
    const offset = runtime.events.length;
    const admitted = await runtime.request<DaemonReloadResponse>(WORKBENCH_RELOAD_METHOD, { scopes, ...(all ? { all: true } : {}) });
    assert.equal(admitted.state, "running");
    assert.deepEqual(admitted.appliedScopes, []);
    await runtime.until(() => {
      const snapshots = runtime.events.slice(offset)
        .filter((event) => event.method === WORKBENCH_RELOAD_DIRT_UPDATED_METHOD)
        .map((event) => WorkbenchDaemonReloadDirtEnvelopeSchema.parse(event.params).snapshot);
      const pending = snapshots.findIndex((snapshot) => snapshot.pendingScopes.length > 0);
      return pending >= 0 && snapshots.slice(pending + 1).some((snapshot) => snapshot.pendingScopes.length === 0);
    }, AbortSignal.any([t.signal, AbortSignal.timeout(90_000)]));
    const dirt = await serverDirt();
    if (failure) assert.match(dirt.error ?? "", /Lifecycle injected activation failure/u);
    else clean(dirt);
  };
  const reloadApp = async (scopes: string[], failure = false) => {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(90_000)]);
    const offset = runtime.appOutput.length;
    const response = await http(runtimePath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes }) });
    assert.equal(response.status, 202);
    await runtime.until(() => {
      const output = runtime.appOutput.slice(offset);
      return output.includes(failure ? "reload execution failed:" : "reloaded app nodes:");
    }, signal);
    // The swap log precedes the controller's async dirt refresh.
    let dirt = await appDirt(signal);
    while (dirt.pendingScopes.length) dirt = await appDirt(signal);
    if (failure) assert.match(dirt.error ?? "", /Lifecycle injected activation failure/u);
    else clean(dirt);
  };
  try {
    const captured = await captureThreadStateMigrationSource(
      path.join(resolveWorkbenchDataRoot(), "daemon", "workbench.sqlite3"),
      runtime.root,
    );
    await verifyThreadStateMigrationSource(captured);
    const capturedCounts = await installThreadStateMigrationSource(captured, serverDatabase, runtime.root);
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(retainedFile, retainedContents);
    let subscriptionIndex = 0;
    const verifyTranscript = async (nativeAvailable = true) => {
      if (nativeAvailable) {
        const pending = await runtime.daemon.questionnaires.pending();
        assert.ok(Array.isArray(pending.data), "WB actions must reach the current provider definition after startup or replacement");
      } else {
        await assert.rejects(runtime.daemon.questionnaires.pending(), /Lifecycle injected native unavailability/u,
          "Provider operations must fail individually while shared SQL remains available");
      }
      assert.equal(await fs.readFile(retainedFile, "utf8"), retainedContents, "Reload must preserve legacy evidence");
      assert.deepEqual((await fs.readdir(legacyRoot, { recursive: true })).filter(file => /\.(?:json|jsonl|ndjson)$/u.test(file)),
        [path.basename(retainedFile)], "SQL reads and reload must not create legacy transcript files");
      const request = { threadId: transcript.threadId, turnLimit: 1 };
      const snapshot = await runtime.transcripts.read(request);
      assert.ok(snapshot);
      assert.deepEqual(snapshot.loadedTurnIds, [transcript.turnId]);
      const projection = projectWorkbenchTranscript(snapshot);
      assert.ok(projection.success);
      const item = projection.data.turns[0]?.items[0];
      assert.equal(item?.id, transcript.itemId);
      assert.ok(item?.type === "userMessage");
      const image = item.content[0];
      assert.ok(image?.type === "image");
      const response = await fetch(new URL(image.url.replace("/api/transcript-assets/", "/daemon/transcript-assets/"), runtime.origin), { signal: t.signal });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), transcript.bytes);
      const retainedAsset = await fetch(new URL(image.url.replace("/api/transcript-assets/", "/daemon/transcript-assets/codex/"), runtime.origin), { signal: t.signal });
      assert.equal(retainedAsset.status, 200);
      assert.deepEqual(Buffer.from(await retainedAsset.arrayBuffer()), transcript.bytes);
      for (const retired of ["runtime/composer-profiles.json", "runtime/turn-recovery-handoff.json"]) {
        await assert.rejects(fs.stat(path.join(runtime.project, ".workbench", retired)), { code: "ENOENT" });
      }
      const updates: TranscriptStreamUpdate[] = [];
      const subscriptionId = `lifecycle-${++subscriptionIndex}`;
      await runtime.transcripts.subscribe({ ...request, subscriptionId }, () => {
        assert.fail("The real socket must deliver the incremental protocol, not a legacy snapshot.");
      }, update => { updates.push(update); });
      try {
        await runtime.until(() => updates.some(update => update.kind === "structure"));
        const baseline = updates.find(update => update.kind === "structure");
        assert.ok(baseline?.kind === "structure" && baseline.reset);
        assert.deepEqual(baseline.snapshot.loadedTurnIds, [transcript.turnId]);
        const database = new Database(serverDatabase, { readonly: true });
        try {
          assert.equal(database.prepare("SELECT previous_cursor FROM codex_transcript_turn_cursors WHERE turn_id = ?").pluck().get(transcript.turnId), null);
          assert.deepEqual(database.pragma("foreign_key_check"), [], "Reload must retain project ownership");
          assert.equal(database.prepare("SELECT project_id FROM workbench_threads WHERE id = ?").pluck().get(transcript.threadId), fixtureProject.id);
          assert.equal(database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'workbench_thread_state_projects'").get(), undefined);
          for (const table of workbenchDatabaseSchema.currentTables) {
            for (const column of ["project_id", "scope_project_id"]) {
              if (!(column in table.columns)) continue;
              const foreignKeys = database.pragma(`foreign_key_list("${table.name}")`) as Array<{ table: string; from: string; to: string }>;
              assert.ok(foreignKeys.some(key => key.table === "workbench_projects" && key.from === column && key.to === "id"),
                `${table.name}.${column} must retain its project parent constraint`);
            }
          }
        } finally { database.close(); }
      } finally { await runtime.transcripts.unsubscribe({ subscriptionId }); }
    };
    await installLifecycleProbe(runtime.project);
    await writeLifecycleFault(runtime.project, { nativeInitialization: true });
    const daemonStart = performance.now();
    await runtime.start();
    let transcriptReady = false;
    const stopAvailability = runtime.transcripts.onAvailabilityChange(available => { transcriptReady = available; });
    stopAvailability();
    assert.ok(transcriptReady, "Scenario startup must include transcript protocol readiness, not just an open socket");
    const daemonStartupMs = Math.round(performance.now() - daemonStart);
    const catalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    const fixtureProject = catalog.data.find(project => path.resolve(project.rootPath) === runtime.project);
    assert.ok(fixtureProject);
    const transcript = await seedLifecycleTranscript(runtime.project, serverDatabase, fixtureProject.id);
    const appStart = performance.now();
    const legacyApp = new WorkbenchAppStateRepository({ databasePath: appDatabase });
    await legacyApp.start();
    try {
      new WorkbenchNetworkRepository(legacyApp).write({
        hostServe: { enabled: false, port: 8123 }, privateAccess: null, members: [],
      });
    } finally { await legacyApp.close(); }
    await runtime.startApp();
    await verifyEndpoint();
    const initialService = await serviceIdentity();
    const importedService = new Database(serviceDatabase, { readonly: true });
    try {
      const repository = new WorkbenchNetworkRepository({
        query: <Row extends WorkbenchDatabaseRow>(statement: WorkbenchDatabaseQuery<Row>): Row[] => {
          const compiled = compileWorkbenchDatabaseStatement(serviceTableInventory, statement);
          return importedService.prepare(compiled.sql).all(...compiled.parameters) as Row[];
        },
        executeTransaction: () => { throw new Error("Import verification must not mutate service state."); },
      });
      assert.equal(repository.read().hostServe.port, 8123);
      assert.equal(importedService.prepare("SELECT count(*) FROM service_network_import").pluck().get(), 1);
    } finally { importedService.close(); }
    const appStartupMs = Math.round(performance.now() - appStart);
    console.log(`cold startup to scenario readiness: daemon ${daemonStartupMs}ms, app ${appStartupMs}ms`);
    for (const output of [runtime.output, runtime.appOutput]) {
      console.log(output.split(/\r?\n/u).filter(line => line.startsWith("[startup] ")).join("\n"));
    }
    await assets();
    await assert.rejects(runtime.request("initialize", {}), /Workbench method not found/u);
    const retiredIngress = await fetch(new URL("/daemon/bridge-request", runtime.origin), { method: "POST", signal: t.signal });
    assert.equal(retiredIngress.status, 404);
    await verifyTranscript(false);
    assert.ok(runtime.output.includes("[lifecycle] native-unavailable server:codex"),
      "Cold startup must exercise unavailable native readiness, not merely omit native work");
    const recoveredOffset = runtime.output.length;
    await writeLifecycleFault(runtime.project, {});
    await runtime.until(() => runtime.output.slice(recoveredOffset).includes("[codex-recovery] Recovered Codex after:"),
      AbortSignal.any([t.signal, AbortSignal.timeout(90_000)]));
    await verifyTranscript();
    const ids = runtime.processIds;
    assert.ok(ids.app && ids.daemon);
    const registration = await appState();
    assert.ok(registration.daemonRegistrationId);
    console.log("cold entrypoints, SQLite, compiled assets and ingress passed");

    await reloadServer(["harness:codex"]);
    await verifyTranscript();
    await writeLifecycleFault(runtime.project, { fail: "server:codex" });
    await reloadServer(["server:codex/lifecycle"], true);
    await verifyTranscript();
    await writeLifecycleFault(runtime.project, {});
    await reloadServer(["server:codex/lifecycle"]);
    await verifyTranscript();
    assert.deepEqual(runtime.processIds, ids);
    console.log("native unavailability, child replacement and lifecycle rollback preserve WB reads");

    await reloadServer(["server:database"]);
    await reloadApp(["client:database"]);
    await reloadServer(["server:core", "server:topology", "server:commands", "server:websocket"], false, true);
    assert.deepEqual(runtime.processIds, ids);
    await verifyTranscript();
    console.log("database reload and reload-all passed without process dirt");

    for (const owner of ["daemon", "app"] as const) {
      const server = owner === "daemon";
      const scope = server ? "server:database" : "client:database";
      const fail = server ? "server:core" : "client:http";
      const database = server ? serverDatabase : appDatabase;
      const reload = server ? reloadServer : reloadApp;
      const output = () => server ? runtime.output : runtime.appOutput;
      const previous = inspectDatabase(database);
      const table = await appendLifecycleMigration(runtime.project, owner, previous.version + 1);
      await writeLifecycleFault(runtime.project, { hold: scope, fail, database, table });
      const offset = output().length;
      console.log(`${owner}: holding real old-work grace, then failing after migration`);
      await reload([scope], true);
      const failed = output().slice(offset);
      assert.ok(failed.includes(`[lifecycle] held ${scope}`));
      assert.ok(failed.includes(`[lifecycle] expired ${scope}`), "Expired drain must continue replacement, not cancel it");
      assert.ok(failed.includes(`[lifecycle] migration-observed ${fail}`), "Failure must follow real migration");
      assert.ok(failed.includes(`[lifecycle] resumed ${scope}`), "The retained database must resume");
      const heldIdentity = failed.match(new RegExp(`\\[lifecycle\\] held ${scope} ([a-f0-9-]+)`, "u"))?.[1];
      assert.ok(heldIdentity);
      assert.ok(failed.includes(`[lifecycle] resumed ${scope} ${heldIdentity}`), "Rollback must resume the retained owner");
      assert.deepEqual(inspectDatabase(database, table), { version: previous.version, table: false, integrity: "ok" });
      assert.equal((await appState()).daemonRegistrationId, registration.daemonRegistrationId);
      await runtime.request("project/catalog/read");
      await assets();
      await verifyTranscript();
      assert.deepEqual(runtime.processIds, ids, "Rollback must not require process restart");

      // Keep the held drain on retry: an old generation must expire fresh work again.
      await writeLifecycleFault(runtime.project, { hold: scope });
      const retryOffset = output().length;
      await reload([scope]);
      assert.ok(output().slice(retryOffset).includes(`[lifecycle] expired ${scope}`));
      assert.ok(output().slice(retryOffset).includes(`[lifecycle] held ${scope} ${heldIdentity}`), "Retry must replace that same retained owner");
      assert.deepEqual(inspectDatabase(database, table), { version: previous.version + 1, table: true, integrity: "ok" });
      assert.deepEqual(runtime.processIds, ids);
      console.log(`${owner}: schema restored after failure; same-process retry migrated successfully`);
      await writeLifecycleFault(runtime.project, {});
    }
    const previousInstance = runtime.daemonEndpoint.instanceId;
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 }, "Owners must complete shutdown successfully before reopen");
    assert.equal(await readDaemonEndpoint(endpointPath), null, "Shutdown must withdraw the retired endpoint");
    await runtime.start();
    assert.notEqual(runtime.daemonEndpoint.instanceId, previousInstance);
    assert.deepEqual((await runtime.transcripts.read({ threadId: transcript.threadId, turnLimit: 1 }))?.loadedTurnIds,
      [transcript.turnId], "Cold startup must permit an immediate durable read");
    await runtime.startApp();
    await verifyEndpoint();
    assert.equal((await serviceIdentity()).daemonId, initialService.daemonId);
    await assets();
    await verifyTranscript();
    assert.equal((await appState()).daemonRegistrationId, registration.daemonRegistrationId);
    await runtime.request("project/catalog/read");
    clean(await appDirt());
    clean(await serverDirt());
    assert.equal(inspectDatabase(appDatabase).integrity, "ok");
    assert.equal(inspectDatabase(serverDatabase).integrity, "ok");
    const reopened = new Database(serverDatabase, { readonly: true });
    try {
      assert.equal(reopened.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get(), capturedCounts.states);
      assert.equal(reopened.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get(), capturedCounts.relationships);
      assert.ok(Number(reopened.prepare("SELECT count(*) FROM workbench_threads").pluck().get()) >= Number(capturedCounts.threads));
    } finally { reopened.close(); }
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 });
    console.log("cold reopening preserved durable state");
    await writeLifecycleFault(runtime.project, { fail: "client:http", initial: true });
    await assert.rejects(runtime.startApp(), /Lifecycle injected activation failure/u);
    assert.equal(await runtime.waitForAppExit(), 1, "Failed startup must close its owners and exit without external killing");
    assert.equal((await serviceIdentity()).daemonId, initialService.daemonId, "App failure must leave the independent host available.");
    console.log("failed startup cleaned up its own resources; lifecycle checks passed");
  } catch (error) {
    console.error("lifecycle failed", error, "\napp tail\n", runtime.appOutput.slice(-12000), "\ndaemon tail\n", runtime.output.slice(-12000));
    throw error;
  } finally {
    await runtime.close();
  }
});

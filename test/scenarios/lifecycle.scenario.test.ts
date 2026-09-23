/*
 * No exports. Verify real database migration and essential app operation, without provider turns.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import WorkbenchProjectClient from "../../app/client/workbench/WorkbenchProjectClient";
import WorkbenchClientStateController from "../../app/client/workbench/state/WorkbenchClientStateController";
import IsolatedWorkbench from "./IsolatedWorkbench";
import { seedLifecycleTranscript } from "./lifecycle-fixture";
import { captureThreadStateMigrationSource, verifyThreadStateMigrationSource, isolateThreadStateMigrationSource } from "./thread-state-migration-fixture";
import type { WorkbenchProjectsPayload } from "../../shared/types";
import { projectWorkbenchTranscript } from "../../shared/workbench/transcript/workbench-transcript-projection";
import type { TranscriptStreamUpdate } from "../../shared/workbench/transcript/thread-transcript-stream";
import { WorkbenchGlobalThreadStateOpenResultSchema, WorkbenchThreadStateOpenResultSchema } from "../../shared/workbench/thread/thread-state";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import { readDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint";
import { WorkbenchDaemonConnectionSchema, WorkbenchDaemonEndpointSchema } from "../../shared/http/workbench-daemon-endpoint";
import { readServiceEndpoint } from "../../shared/process/workbench-service-endpoint";
import { WorkbenchDaemonIdentitySchema } from "../../shared/http/workbench-daemon-discovery";
import WorkbenchAppStateRepository from "../../app/server/state/WorkbenchAppStateRepository";
import { WorkbenchProjectLocationsPayloadSchema } from "../../shared/workbench/project/project-location";
import { PresentationSnapshotSchema } from "../../shared/state/workbench-presentation-state";
import { presentationSchema } from "../../shared/state/workbench-presentation-schema";
import WorkbenchNetworkRepository from "../../daemon/host/network/WorkbenchNetworkRepository";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseQuery, type WorkbenchDatabaseRow } from "../../shared/database/workbench-database-statements";
import { serviceTableInventory } from "../../shared/state/workbench-service-schema";
import { ProjectDiscoverySettingsResultSchema } from "../../shared/workbench/project/project-discovery-settings";
import { WorkbenchProjectsPayloadSchema } from "../../shared/workbench/project/project-state";

test("forward database migration preserves data and the real app can use it", {
  skip: process.env.WORKBENCH_LIFECYCLE_TEST_FILE !== "test/scenarios/lifecycle.scenario.test.ts",
  // Leave the outer five-minute runner budget room to retire children and clean up.
  timeout: 240_000,
}, async t => {
  const runtime = await IsolatedWorkbench.create(path.resolve(process.cwd(), ".."), t.signal, { codexIdentity: false });
  console.log(`migration fixture: ${runtime.root}`);
  const appDatabase = path.join(runtime.dataRootPath, "app", "app-state.sqlite3");
  const presentationDatabase = path.join(runtime.dataRootPath, "app", "presentation-state.sqlite3");
  const serverDatabase = path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3");
  const serviceDatabase = path.join(runtime.dataRootPath, "service", "service.sqlite3");
  let failed = false;
  let failure: unknown;
  try {
    runtime.markPhase("capturing the database migration source");
    let reportedAt = -Infinity;
    const captured = await captureThreadStateMigrationSource(
      path.join(resolveWorkbenchDataRoot(), "daemon", "workbench.sqlite3"), serverDatabase, {
        signal: t.signal,
        onProgress: ({ totalPages, remainingPages }) => {
          const now = performance.now();
          if (now - reportedAt < 5_000) return;
          reportedAt = now;
          runtime.markPhase(`database capture: ${totalPages - remainingPages}/${totalPages} pages copied`);
        },
      });
    // The managed host imports app-owned settings on its first start.
    const legacyApp = new WorkbenchAppStateRepository({ databasePath: appDatabase });
    await legacyApp.start();
    try {
      new WorkbenchNetworkRepository(legacyApp).write({
        hostServe: { enabled: false, port: 8123 }, privateAccess: null, members: [],
      });
    } finally { await legacyApp.close(); }
    runtime.markPhase("reloading a host-owned daemon with retained discovery roots");
    await runtime.exerciseManagedProcessReload(path.resolve(process.cwd(), ".."));
    await runtime.stop();
    runtime.markPhase("verifying forward migration and retained data");
    await verifyThreadStateMigrationSource(captured);
    runtime.markPhase("isolating the verified database paths in place");
    const capturedCounts = await isolateThreadStateMigrationSource(captured, runtime.root, t.signal);

    const clonePath = path.join(path.dirname(runtime.project), "fixture-clone");
    const sharedRemote = "https://example.test/workbench/scenario.git";
    await IsolatedWorkbench.command("git", ["clone", "-q", "--no-hardlinks", runtime.project, clonePath],
      runtime.root, process.env, t.signal);
    await IsolatedWorkbench.command("git", ["remote", "add", "origin", sharedRemote],
      runtime.project, process.env, t.signal);
    await IsolatedWorkbench.command("git", ["remote", "set-url", "origin", sharedRemote],
      clonePath, process.env, t.signal);

    await runtime.start();
    const emptyCatalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    assert.ok(!emptyCatalog.data.some(entry => path.resolve(entry.rootPath) === runtime.project),
      "The migrated daemon must not adopt the old environment root");
    const savedRoots = ProjectDiscoverySettingsResultSchema.parse(
      await runtime.request("project/discovery-settings/update", { paths: [path.dirname(runtime.project)] }));
    assert.deepEqual(savedRoots, { accepted: true, paths: [path.dirname(runtime.project)] });
    const catalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    const project = catalog.data.find(entry => path.resolve(entry.rootPath) === runtime.project);
    assert.ok(project, "The migrated daemon must discover the isolated project");
    const clone = catalog.data.find(entry => path.resolve(entry.rootPath) === clonePath);
    assert.ok(clone, "The legacy catalogue must expose the second checkout");
    assert.notEqual(project.id, clone.id, "Matching remotes must not merge concrete execution owners");
    const transcript = await seedLifecycleTranscript(runtime.project, serverDatabase, project.id);

    await runtime.startApp();

    const verifyApp = async (label: string) => {
      let lastPort: number | null | undefined;
      return await runtime.phase(label, async signal => {
        const http = async (route: string) => {
          const response = await fetch(new URL(route, runtime.appOrigin), { signal });
          assert.ok(response.ok, `App ${route}: ${response.status}`);
          return response;
        };
        const endpoint = runtime.daemonEndpoint;
        assert.deepEqual(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), endpoint);
        const health = await fetch(`${endpoint.origin}/healthz`, { signal });
        assert.ok(health.ok);
        assert.deepEqual(WorkbenchDaemonEndpointSchema.parse(await health.json()), endpoint);
        for (;;) {
          signal.throwIfAborted();
          const connection = WorkbenchDaemonConnectionSchema.parse(
            await (await http("/api/workbench-network?connection=1")).json());
          lastPort = connection.localPort;
          if (lastPort === null) continue;
          assert.equal(lastPort, Number(new URL(endpoint.origin).port));
          break;
        }
        const appState = await (await http("/api/workbench-client-state")).json() as { daemonRegistrationId: string };
        assert.ok(appState.daemonRegistrationId, "The app must register its daemon");
        assert.equal("registrations" in appState, false, "The old app-state response shape must remain available");
        const service = await readServiceEndpoint(path.join(runtime.dataRootPath, "service", "runtime.json"));
        assert.ok(service);
        const identity = await fetch(`${service.origin}/_workbench-service/identity`, { signal });
        assert.ok(identity.ok);
        const hostIdentity = WorkbenchDaemonIdentitySchema.parse(await identity.json());
        const locationCatalog = WorkbenchProjectLocationsPayloadSchema.parse(
          await runtime.request("project/locations/read", {}, {}, signal));
        const registered = await fetch(new URL("/api/workbench-presentation/mutate", runtime.appOrigin), {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "registerLocations", daemonId: hostIdentity.daemonId,
            hostname: hostIdentity.hostname, catalog: locationCatalog }),
        });
        assert.equal(registered.status, 200);
        const presentation = PresentationSnapshotSchema.parse(
          await (await http("/api/workbench-presentation")).json());
        const primaryLocation = presentation.locations.find(location =>
          location.target.daemonId === hostIdentity.daemonId && location.target.projectId === project.id);
        const cloneLocation = presentation.locations.find(location =>
          location.target.daemonId === hostIdentity.daemonId && location.target.projectId === clone.id);
        assert.ok(primaryLocation && cloneLocation);
        assert.equal(primaryLocation.logicalProjectId, cloneLocation.logicalProjectId,
          "The new presentation owner must group matching remotes without merging execution locations");
        const presentationFile = new Database(presentationDatabase, { readonly: true });
        try {
          assert.equal(presentationFile.pragma("user_version", { simple: true }), presentationSchema.currentVersion);
        } finally { presentationFile.close(); }
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

        runtime.markPhase("verifying compiled app assets and thread-state loading");
        const html = await (await http("/")).text();
        const urls = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gu)]
          .map(match => match[1]);
        assert.ok(urls.some(url => url.includes(".js")), "The app must serve a compiled script");
        assert.ok(urls.some(url => url.includes(".css")), "The app must serve compiled styles");
        for (const url of urls) {
          assert.equal(new URL(url, runtime.appOrigin).origin, runtime.appOrigin);
          assert.ok((await (await http(url)).arrayBuffer()).byteLength > 0);
        }
        const globalState = WorkbenchGlobalThreadStateOpenResultSchema.parse(
          await runtime.request("workbench/thread-state/global/open", { version: 7 }, {}, signal));
        assert.ok(globalState.catalog.data.some(entry => entry.id === project.id));
        const legacyGlobalState = WorkbenchGlobalThreadStateOpenResultSchema.parse(
          await runtime.request("workbench/thread-state/global/open", { version: 5 }, {}, signal));
        assert.ok(legacyGlobalState.projectSidebars.projects.some(entry => entry.projectId === project.id));
        assert.ok(legacyGlobalState.projectSidebars.projects.some(entry => entry.projectId === clone.id));
        const legacyClientState = new WorkbenchClientStateController({ mode: "memory" });
        const legacyProjectClient = WorkbenchProjectClient({ clientStateController: legacyClientState, transport: {
          readCatalog: async () => WorkbenchProjectsPayloadSchema.parse(
            await runtime.request("project/catalog/read", {}, {}, signal)),
          createEntry: async () => { throw new Error("Compatibility check must not mutate files."); },
          deleteFile: async () => { throw new Error("Compatibility check must not mutate files."); },
          refresh: async () => { throw new Error("Compatibility check must not mutate files."); },
        } });
        try {
          for (const location of [project, clone]) {
            assert.equal(await legacyProjectClient.selectProjectStrict(location.id), true);
            const selected = legacyProjectClient.getSnapshot();
            assert.equal(selected.currentProjectId, location.id);
            assert.equal(path.resolve(selected.rootPath), path.resolve(location.rootPath));
            assert.ok(selected.projects.some(entry => entry.id === project.id));
            assert.ok(selected.projects.some(entry => entry.id === clone.id));
          }
        } finally {
          legacyProjectClient.dispose();
          legacyClientState.dispose();
        }
        const projectState = WorkbenchThreadStateOpenResultSchema.parse(
          await runtime.request("workbench/thread-state/open", { projectId: project.id, version: 4 }, {}, signal));
        assert.ok(projectState.catalog.data.some(entry => entry.id === project.id));

        runtime.markPhase("verifying transcript reads, subscriptions and image delivery");
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
        const response = await fetch(new URL(
          image.url.replace("/api/transcript-assets/", "/daemon/transcript-assets/"), runtime.origin), { signal });
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), transcript.bytes);

        const updates: TranscriptStreamUpdate[] = [];
        const subscriptionId = "migration-transcript";
        await runtime.transcripts.subscribe({ ...request, subscriptionId }, () => {
          assert.fail("The real socket must deliver the incremental transcript protocol.");
        }, update => { updates.push(update); });
        try {
          await runtime.until(() => updates.some(update => update.kind === "structure"), signal);
          const baseline = updates.find(update => update.kind === "structure");
          assert.ok(baseline?.kind === "structure" && baseline.reset);
          assert.deepEqual(baseline.snapshot.loadedTurnIds, [transcript.turnId]);
        } finally { await runtime.transcripts.unsubscribe({ subscriptionId }); }

        const database = new Database(serverDatabase, { readonly: true });
        try {
          assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
          assert.equal(database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get(), capturedCounts.states);
          assert.equal(database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get(), capturedCounts.relationships);
          assert.ok(Number(database.prepare("SELECT count(*) FROM workbench_threads").pluck().get()) >= Number(capturedCounts.threads));
          assert.equal(database.prepare("SELECT project_id FROM workbench_threads WHERE id = ?").pluck().get(transcript.threadId), project.id);
        } finally { database.close(); }
        return { registrationId: appState.daemonRegistrationId, hostId: hostIdentity.daemonId,
          logicalProjectId: primaryLocation.logicalProjectId };
      }).catch(error => {
        throw new Error(`${label} failed; last localPort: ${lastPort === undefined ? "not observed" : lastPort}`,
          { cause: error });
      });
    };

    const initialIdentity = await verifyApp("post-migration app smoke checks");
    const initialInstance = runtime.daemonEndpoint.instanceId;
    runtime.markPhase("graceful shutdown after migration and app validation");
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 });
    assert.equal(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), null);

    // Reuse the migrated files without reseeding: fresh processes must read durable state.
    await runtime.start();
    assert.notEqual(runtime.daemonEndpoint.instanceId, initialInstance);
    await runtime.startApp();
    assert.deepEqual(await verifyApp("cold-reopened app smoke checks"), initialIdentity,
      "Cold reopening must preserve app registration and host identity");
    runtime.markPhase("graceful shutdown after cold reopening");
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 });
    assert.equal(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), null);
    console.log("migration validation, core app checks and cold reopening passed");
  } catch (error) {
    failed = true;
    failure = error;
    runtime.markPhase("migration or app validation failed; preserving diagnostics");
    throw error;
  } finally {
    try { await runtime.close({ preserveDiagnostics: failed }); }
    catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Migration scenario and cleanup both failed");
      throw cleanupError;
    }
  }
});

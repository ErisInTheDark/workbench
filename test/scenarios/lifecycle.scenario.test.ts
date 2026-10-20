/*
 * No exports. Copy the real daemon database into an isolated Workbench, boot it to migrate and check the app and daemon
 * work together, then boot it again without migrating and check them again. No provider turns.
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import IsolatedWorkbench, { type IsolatedWorkbenchOptions } from "./IsolatedWorkbench";
import {
  captureThreadStateMigrationSource, isolateThreadStateMigrationSource, readDatabaseBackups,
} from "./thread-state-migration-fixture";
import type { WorkbenchProjectsPayload } from "../../shared/types";
import { workbenchDatabaseSchema } from "../../daemon/server/database/workbench-database-schema";
import resolveWorkbenchDataRoot from "../../shared/workbench-data-root";
import { readDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint";
import { WorkbenchDaemonEndpointSchema } from "../../shared/http/workbench-daemon-endpoint";
import { readServiceEndpoint } from "../../shared/process/workbench-service-endpoint";
import { WorkbenchDaemonIdentitySchema } from "../../shared/http/workbench-daemon-discovery";
import { presentationSchema } from "../../shared/state/workbench-presentation-schema";
import { ProjectDiscoverySettingsResultSchema } from "../../shared/workbench/project/project-discovery-settings";
import { formatWorkbenchDatabaseDiagnostic } from "../../shared/database/workbench-database-diagnostic";

type ScenarioProcessEvent = Parameters<NonNullable<IsolatedWorkbenchOptions["processEvent"]>>[0];

/** A migrating boot checkpoints, verifies and migrates the whole copied database before it reports ready. */
const MIGRATING_BOOT_READINESS_MS = 600_000;

function reportLifecycleProcessEvent(event: ScenarioProcessEvent) {
  if (event.kind !== "diagnostic") return;
  if (event.diagnostic.source === "startup") {
    const status = event.diagnostic.phase === "pending"
      ? "pending"
      : `ok in ${Math.round(event.diagnostic.elapsedMs ?? 0)}ms`;
    process.stdout.write(`[scenario:startup] reload source baseline ${status}\n`);
    return;
  }
  const line = formatWorkbenchDatabaseDiagnostic(event.diagnostic);
  if (event.diagnostic.level === "warn") process.stderr.write(`[scenario:database] ${line}\n`);
  else process.stdout.write(`[scenario:database] ${line}\n`);
}

test("a copy of the real database migrates once and the app can use it across two boots", {
  skip: process.env.WORKBENCH_LIFECYCLE_TEST_FILE !== "test/scenarios/lifecycle.scenario.test.ts",
  // Leave the outer twenty-one-minute runner budget room to retire children and clean up.
  timeout: 1_200_000,
}, async t => {
  const runtime = await IsolatedWorkbench.create(path.resolve(process.cwd(), ".."), t.signal, {
    codexIdentity: false,
    processEvent: reportLifecycleProcessEvent,
  });
  console.log(`migration fixture: ${runtime.root}`);
  const presentationDatabase = path.join(runtime.dataRootPath, "app", "presentation-state.sqlite3");
  const serverDatabase = path.join(runtime.dataRootPath, "daemon", "workbench.sqlite3");
  const browserStateId = randomUUID();
  const localPath = path.join(path.dirname(runtime.project), "fixture-local");
  let failed = false;
  let failure: unknown;
  try {
    runtime.markPhase("copying the real daemon database");
    let reportedAt = -Infinity;
    const captured = await captureThreadStateMigrationSource(
      path.join(resolveWorkbenchDataRoot(), "daemon", "workbench.sqlite3"), serverDatabase, {
        signal: t.signal,
        onProgress: ({ totalPages, remainingPages }) => {
          const now = performance.now();
          if (now - reportedAt < 5_000) return;
          reportedAt = now;
          runtime.markPhase(`database copy: ${totalPages - remainingPages}/${totalPages} pages`);
        },
      });
    // No process may see the real filesystem addresses, so the copy is isolated before its first boot.
    runtime.markPhase("isolating the copied database paths");
    const capturedCounts = await isolateThreadStateMigrationSource(serverDatabase, runtime.root, t.signal);
    await fs.mkdir(localPath);
    await IsolatedWorkbench.command("git", ["init", "-q"], localPath, process.env, t.signal);
    await fs.writeFile(path.join(localPath, "local.txt"), "single folder without a remote\n");
    assert.deepEqual(await readDatabaseBackups(serverDatabase), [], "The fresh copy must start without checkpoints");

    const verifyApp = async (label: string) => await runtime.phase(label, async signal => {
      const catalog = await runtime.waitForProjects([runtime.project, localPath], signal);
      const project = catalog.find(entry => path.resolve(entry.rootPath) === runtime.project);
      const local = catalog.find(entry => path.resolve(entry.rootPath) === localPath);
      assert.ok(project && local, "The daemon must serve the isolated checkout and the plain folder");

      const endpoint = runtime.daemonEndpoint;
      assert.deepEqual(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), endpoint);
      const health = await fetch(`${endpoint.origin}/healthz`, { signal });
      assert.ok(health.ok);
      assert.deepEqual(WorkbenchDaemonEndpointSchema.parse(await health.json()), endpoint);
      const stateQuery = runtime.workspace.observe({ kind: "appState", browserStateId });
      const appState = (await runtime.workspace.waitFor(stateQuery)).data;
      stateQuery.release();
      assert.ok(appState?.daemonRegistrationId, "The app must register its daemon");
      assert.ok(appState.registrations?.some(item => item.daemonId === runtime.daemonId));
      const service = await readServiceEndpoint(path.join(runtime.dataRootPath, "service", "runtime.json"));
      assert.ok(service);
      const identity = await fetch(`${service.origin}/_workbench-service/identity`, { signal });
      assert.ok(identity.ok);
      const hostIdentity = WorkbenchDaemonIdentitySchema.parse(await identity.json());
      await runtime.until(() => runtime.presentation.snapshot().data?.locations.some(item =>
        item.target.daemonId === hostIdentity.daemonId && item.target.projectId === project.id) ?? false, signal);
      const presentationFile = new Database(presentationDatabase, { readonly: true });
      try {
        assert.equal(presentationFile.pragma("user_version", { simple: true }), presentationSchema.currentVersion);
      } finally { presentationFile.close(); }

      runtime.markPhase(`${label}: compiled app assets`);
      const html = await (await fetch(new URL("/", runtime.appOrigin), { signal })).text();
      const urls = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gu)].map(match => match[1]);
      assert.ok(urls.some(url => url.includes(".js")), "The app must serve a compiled script");
      assert.ok(urls.some(url => url.includes(".css")), "The app must serve compiled styles");
      for (const url of urls) {
        const response = await fetch(new URL(url, runtime.appOrigin), { signal });
        assert.ok(response.ok, `App ${url}: ${response.status}`);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
      }

      runtime.markPhase(`${label}: threads, folder tree and Git through the app`);
      const projectState = await runtime.projectThreads(project.id, signal);
      assert.ok(projectState.projects.some(item => item.location.projectId === project.id && item.phase === "current"));
      const localLocation = { daemonId: runtime.daemonId, projectId: local.id };
      const tree = runtime.workspace.observe({ kind: "projectTree", location: localLocation });
      try {
        const observed = await runtime.workspace.waitFor(tree);
        assert.equal(observed.data?.projectId, local.id);
        assert.equal(path.resolve(observed.data!.snapshot.rootPath), localPath);
        const git = await runtime.workspace.daemon({ kind: "folder", location: localLocation })
          .git.workingTree.read({ projectId: local.id, preferCached: false });
        assert.deepEqual(git.errors, []);
        assert.ok(git.repositories.some(item => path.resolve(item.cwd) === localPath));
      } finally { tree.release(); }

      const database = new Database(serverDatabase, { readonly: true });
      try {
        assert.equal(database.pragma("user_version", { simple: true }), workbenchDatabaseSchema.currentVersion);
        assert.equal(Number(database.prepare("SELECT count(*) FROM workbench_thread_states").pluck().get()), capturedCounts.states);
        assert.equal(Number(database.prepare("SELECT count(*) FROM workbench_subagent_relationships").pluck().get()), capturedCounts.relationships);
        assert.ok(Number(database.prepare("SELECT count(*) FROM workbench_threads").pluck().get()) >= capturedCounts.threads);
      } finally { database.close(); }
      return { registrationId: appState.daemonRegistrationId, hostId: hostIdentity.daemonId };
    });

    // Boot 1: the copy migrates, and the app and daemon work on it.
    await runtime.start([], "lifecycle", MIGRATING_BOOT_READINESS_MS);
    const initialCatalog = await runtime.request<WorkbenchProjectsPayload>("project/catalog/read");
    assert.ok(initialCatalog.data.some(entry => path.resolve(entry.rootPath) === runtime.project),
      "The migrated daemon must retain its pinned Workbench checkout");
    const savedRoots = ProjectDiscoverySettingsResultSchema.parse(
      await runtime.request("project/discovery-settings/update", { paths: [path.dirname(runtime.project)] }));
    assert.deepEqual(savedRoots, { accepted: true, paths: [path.dirname(runtime.project)] });
    const migratedIdentity = await verifyApp("boot 1 (migrating) app checks");
    runtime.markPhase("boot 1 shutdown");
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 });
    assert.equal(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), null);
    const migratedBackups = await readDatabaseBackups(serverDatabase);
    if (captured.version < workbenchDatabaseSchema.currentVersion) {
      assert.ok(migratedBackups.some(backup => backup.version === captured.version),
        "Migrating must leave a rollback checkpoint at the copied schema");
    }

    // Boot 2: the migrated files open as they are; nothing migrates, and the app still works.
    await runtime.start();
    assert.deepEqual(await verifyApp("boot 2 (already migrated) app checks"), migratedIdentity,
      "Reopening must keep the app registration and host identity");
    runtime.markPhase("boot 2 shutdown");
    assert.deepEqual(await runtime.stop(), { app: 0, daemon: 0 });
    assert.equal(await readDaemonEndpoint(path.join(runtime.dataRootPath, "daemon", "runtime.json")), null);
    assert.deepEqual(await readDatabaseBackups(serverDatabase), migratedBackups,
      "An already-migrated database must reopen without another migration checkpoint");
    console.log(`database schema ${captured.version} -> ${workbenchDatabaseSchema.currentVersion}; both boots passed their app checks`);
  } catch (error) {
    failed = true;
    failure = error;
    runtime.markPhase("migration or app checks failed; preserving diagnostics");
    throw error;
  } finally {
    try { await runtime.close({ preserveDiagnostics: failed }); }
    catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Migration scenario and cleanup both failed");
      throw cleanupError;
    }
  }
});

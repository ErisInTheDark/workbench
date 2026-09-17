/*
 * No production exports. Tests protect the thin process boundary, app source ownership, and live database replacement.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import WorkbenchAppRuntime from "./WorkbenchAppRuntime.ts";
import AppCompilerNode from "./AppCompilerNode.ts";
import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import type { ReloadableNodeBuild } from "workbench-shared/reload/ReloadableNode";

const appDirectoryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFileAsync = promisify(execFile);
const nonServerSourcePaths = new Set([
  "app/client/browser-entry.tsx",
  "app/server/desktop.ts",
  "app/client/WorkbenchBrowserApp.tsx",
  "app/client/WorkbenchBrowserLogForwarder.ts",
  "app/client/WorkbenchClient.ts",
  "app/server/WorkbenchDesktopLauncher.ts",
]);

function isNonServerSourcePath(sourcePath: string) {
  return nonServerSourcePaths.has(sourcePath)
    || sourcePath.startsWith("app/client/components/")
    || sourcePath.startsWith("app/client/workbench/");
}

class TestResponse extends EventEmitter {
  body = "";
  statusCode = 0;
  writableFinished = false;

  end(body?: string | Buffer) {
    if (body !== undefined) this.body += body.toString();
    this.writableFinished = true;
    this.emit("finish");
    return this;
  }

  writeHead(statusCode: number) {
    this.statusCode = statusCode;
    return this;
  }
}

function runtime() {
  const compiler = {
    close: async () => {},
    shutdown: async () => {},
    retainPublishedGeneration() {},
    retire() {},
    suspend: async () => {},
    resumeAfterFailedReload: async () => {},
    getFrontendGeneration: () => ({ javascript: "javascript-one", stylesheet: "stylesheet-one" }),
    outputDirectoryPath: "C:/workbench-output",
    startWatching: async () => "C:/workbench-output",
  } as unknown as WorkbenchFrontendCompiler;
  const database = {
    close: async () => {},
    start: async () => "registration",
  } as WorkbenchAppStateRepository;
  return new WorkbenchAppRuntime({
    appPort: {
      read: () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "random",
      }),
      update: async () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "setting",
      }),
    },
    createCompiler: () => compiler,
    createDatabase: () => database,
    logger: new WorkbenchProcessLogger({ color: false, writeError: () => {}, writeOutput: () => {} }),
    outputDirectoryPath: "C:/workbench-output",
    repositoryRootPath: path.resolve(appDirectoryPath, ".."),
  });
}

test("compiler replacement commits before its first build completes", async () => {
  let release!: () => void;
  const buildGate = new Promise<void>(resolve => { release = resolve; });
  let builds = 0;
  const compiler = {
    retainPublishedGeneration() {},
    startWatching: async () => { builds++; await buildGate; return "output"; },
    retire() {},
    close: async () => {},
    shutdown: async () => {},
  } as unknown as WorkbenchFrontendCompiler;
  const logger = new WorkbenchProcessLogger({ color: false, writeError() {}, writeOutput() {} });
  const instance = AppCompilerNode.create({ createCompiler: () => compiler } as unknown as AppProcessContext, {
    get: key => key === "logger" ? logger : { readGlobalPreference: () => false },
    handoffState: { generation: { javascript: "old-js", stylesheet: "old-css" } },
    mode: "replacement",
  } as ReloadableNodeBuild<AppRuntimeObjects>);
  const preparing = instance.start();
  try {
    assert.equal(builds, 0, "a private candidate must not start the replacement build");
    await preparing;
    instance.afterCommit?.();
    assert.equal(builds, 1);
  } finally {
    release();
    await preparing;
    await instance.dispose();
  }
});

async function appProductionSourcePaths() {
  const sourcePaths: string[] = [];
  const visit = async (directoryPath: string, relativeDirectoryPath = ""): Promise<void> => {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (["node_modules", "target", "gen"].includes(entry.name)) continue;
      const relativePath = path.posix.join(relativeDirectoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(path.join(directoryPath, entry.name), relativePath);
      } else if (/\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.")) {
        sourcePaths.push(`app/${relativePath}`);
      }
    }
  };
  await visit(appDirectoryPath);
  return sourcePaths.sort();
}

test("assigns every app server source to a reloadable node or the explicit process shell", async () => {
  const target = runtime();
  const owners = (path: string) => target.getReloadScopesForPaths([path]).sort();
  const sourcePaths = await appProductionSourcePaths();
  const unownedServerSources = sourcePaths
    .filter((sourcePath) => !isNonServerSourcePath(sourcePath))
    .filter((sourcePath) => owners(sourcePath).length === 0);
  assert.deepEqual(unownedServerSources, []);
  assert.deepEqual(
    sourcePaths.filter((sourcePath) => isNonServerSourcePath(sourcePath) && owners(sourcePath).length > 0),
    [],
  );

  assert.deepEqual(owners("app/server/state/WorkbenchAppStateRepository.ts"), ["client:database", "client:state"]);
  assert.deepEqual(owners("app/server/state/WorkbenchAppStateController.ts"), ["client:state"]);
  assert.deepEqual(owners("app/server/runtime/WorkbenchAppHttpRouter.ts"), ["client:http"]);
  assert.deepEqual(owners("app/server/WorkbenchFrontendCompiler.ts"), ["client:compiler"]);
  assert.deepEqual(owners("app/client/globals.css"), []);
  assert.deepEqual(owners("app/client/tailwind.css"), []);
  assert.deepEqual(owners("app/server/runtime/AppHttpNode.ts"), ["client:http", "client:topology"]);
  assert.deepEqual(owners("app/server/index.ts"), ["client:process"]);
  assert.deepEqual(owners("app/server/app-command-line.ts"), ["client:process"]);
  assert.deepEqual(owners("app/package.json"), ["client:process"]);
  assert.deepEqual(owners("app/tsconfig.json"), ["client:process"]);
  assert.deepEqual(owners("package.json"), ["client:process"]);
  assert.deepEqual(owners("shared/http/StaticHttpRequestController.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/workbench-app-port.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/workbench-app-settings.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/HttpServer.ts"), ["client:process"]);
  assert.deepEqual(owners("shared/state/workbench-app-state-schema.ts"), ["client:database", "client:state"]);
  assert.deepEqual(owners("shared/state/workbench-app-state-releases.ts"), ["client:database", "client:state"]);
  assert.deepEqual(owners("shared/workbench-data-root.ts"), ["client:database", "client:process", "client:state"]);
  assert.deepEqual(owners("app/server/workbench-runtime-root.ts"), ["client:process"]);
  assert.equal(owners("shared/reload/ReloadableNodeHost.ts").includes("client:process"), true);
  assert.deepEqual(owners("shared/package.json"), ["client:process"]);
  assert.deepEqual(owners("app/tray/src/main.rs"), ["client:process"]);
  assert.deepEqual(owners("app/tray/bin/windows-x64/workbench-tray.exe"), ["client:process"]);
  assert.deepEqual(owners("app/tray/target/release/workbench-tray.exe"), []);
});

test("reloads the database with a fresh repository constructor and no process restart", async (context) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "workbench-app-runtime-reload-"));
  context.after(async () => await rm(rootPath, { force: true, recursive: true }));
  const outputDirectoryPath = path.join(rootPath, "output");
  const databasePath = path.join(rootPath, "app-state.sqlite3");
  await Promise.all(["app", "shared"].map(async (directory) => {
    await mkdir(path.join(rootPath, directory), { recursive: true });
  }));
  await mkdir(outputDirectoryPath, { recursive: true });
  await writeFile(path.join(rootPath, "README.md"), "reload fixture\n", "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: rootPath });
  await execFileAsync("git", ["config", "user.email", "workbench-tests@example.invalid"], { cwd: rootPath });
  await execFileAsync("git", ["config", "user.name", "Workbench Tests"], { cwd: rootPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: rootPath });
  await execFileAsync("git", ["commit", "-q", "-m", "fixture"], { cwd: rootPath });

  const constructors: Array<typeof WorkbenchAppStateRepository> = [];
  const compilerModes: boolean[] = [];
  const databaseEvents: string[] = [];
  let reloadLine = "";
  let resolveReload!: () => void;
  let rejectReload!: (error: Error) => void;
  const reloaded = new Promise<void>((resolve, reject) => {
    resolveReload = resolve;
    rejectReload = reject;
  });
  const target = new WorkbenchAppRuntime({
    appPort: {
      read: () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "random",
      }),
      update: async () => ({
        appOrigin: "http://127.0.0.1:43210",
        currentPort: 43_210,
        editable: true,
        source: "setting",
      }),
    },
    createCompiler: (_logger, readReactDevelopmentMode) => {
      return {
        close: async () => {},
        shutdown: async () => {},
        retainPublishedGeneration() {},
        retire() {},
        suspend: async () => {},
        resumeAfterFailedReload: async () => {},
        getFrontendGeneration: () => ({ javascript: "javascript-one", stylesheet: "stylesheet-one" }),
        outputDirectoryPath,
        startWatching: async () => {
          compilerModes.push(readReactDevelopmentMode());
          return outputDirectoryPath;
        },
      } as unknown as WorkbenchFrontendCompiler;
    },
    createDatabase: (Repository) => {
      constructors.push(Repository);
      const generation = constructors.length;
      const repository = new Repository({ databasePath });
      const close = repository.close.bind(repository);
      const start = repository.start.bind(repository);
      repository.close = () => {
        databaseEvents.push(`close:${generation}`);
        return close();
      };
      repository.start = () => {
        databaseEvents.push(`start:${generation}`);
        return start();
      };
      return repository;
    },
    logger: new WorkbenchProcessLogger({
      color: false,
      writeError: (line) => {
        if (line.includes("reload execution failed:")) rejectReload(new Error(line.trim()));
      },
      writeOutput: (line) => {
        if (!line.includes("reloaded app nodes:")) return;
        reloadLine = line;
        resolveReload();
      },
    }),
    outputDirectoryPath,
    repositoryRootPath: rootPath,
  });

  let started = false;
  try {
    await target.start();
    started = true;
    await target.writeAppPort(43_211);

    const settingsRequest = Readable.from([
      JSON.stringify({ reactDevelopmentMode: true }),
    ]) as import("node:http").IncomingMessage;
    settingsRequest.method = "PUT";
    settingsRequest.url = "/api/workbench-app-settings";
    const settingsResponse = new TestResponse();
    await target.handleRequest(
      settingsRequest,
      settingsResponse as unknown as import("node:http").ServerResponse,
    );
    assert.equal(settingsResponse.statusCode, 200);

    const dirtyRequest = Readable.from([]) as import("node:http").IncomingMessage;
    dirtyRequest.method = "GET";
    dirtyRequest.url = "/api/workbench-app-runtime?version=2";
    const dirtyResponse = new TestResponse();
    await target.handleRequest(
      dirtyRequest,
      dirtyResponse as unknown as import("node:http").ServerResponse,
    );
    assert.deepEqual(
      JSON.parse(dirtyResponse.body).reloadDirt.dirtyScopes.map(({ scope }: { scope: string }) => scope),
      ["client:process"],
    );

    const request = Readable.from([JSON.stringify({ scopes: ["client:database"] })]) as import("node:http").IncomingMessage;
    request.method = "POST";
    request.url = "/api/workbench-app-runtime";
    const response = new TestResponse();
    await target.handleRequest(request, response as unknown as import("node:http").ServerResponse);
    assert.equal(response.statusCode, 202);
    await reloaded;

    assert.equal(constructors.length, 2);
    assert.deepEqual(compilerModes, [false, false]);
    assert.notEqual(constructors[0], constructors[1]);
    assert.deepEqual(databaseEvents, ["start:1", "close:1", "start:2"]);
    assert.equal(target.readAppPort(), 43_211);
    assert.match(reloadLine, /client:database/u);
    assert.match(reloadLine, /client:state/u);
    assert.match(reloadLine, /client:compiler/u);
    assert.match(reloadLine, /client:http/u);
    assert.doesNotMatch(reloadLine, /client:process/u);

    const restoreRequest = Readable.from([
      JSON.stringify({ reactDevelopmentMode: false }),
    ]) as import("node:http").IncomingMessage;
    restoreRequest.method = "PUT";
    restoreRequest.url = "/api/workbench-app-settings";
    const restoreResponse = new TestResponse();
    await target.handleRequest(
      restoreRequest,
      restoreResponse as unknown as import("node:http").ServerResponse,
    );
    assert.equal(restoreResponse.statusCode, 200);

    const cleanRequest = Readable.from([]) as import("node:http").IncomingMessage;
    cleanRequest.method = "GET";
    cleanRequest.url = "/api/workbench-app-runtime?version=2";
    const cleanResponse = new TestResponse();
    await target.handleRequest(
      cleanRequest,
      cleanResponse as unknown as import("node:http").ServerResponse,
    );
    assert.deepEqual(JSON.parse(cleanResponse.body).reloadDirt.dirtyScopes, []);

    const generationRequest = Readable.from([]) as import("node:http").IncomingMessage;
    generationRequest.method = "GET";
    generationRequest.url = "/api/workbench-app-runtime?version=3";
    const generationResponse = new TestResponse();
    await target.handleRequest(
      generationRequest,
      generationResponse as unknown as import("node:http").ServerResponse,
    );
    assert.deepEqual(JSON.parse(generationResponse.body).frontendGeneration, {
      javascript: "javascript-one",
      stylesheet: "stylesheet-one",
    });
  } finally {
    if (started) await target.close();
  }
});

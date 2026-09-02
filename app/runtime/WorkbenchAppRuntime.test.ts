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

import WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type WorkbenchFrontendCompiler from "../WorkbenchFrontendCompiler.ts";
import type WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import WorkbenchAppRuntime from "./WorkbenchAppRuntime.ts";

const appDirectoryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const nonServerSourcePaths = new Set([
  "app/browser-entry.tsx",
  "app/desktop.ts",
  "app/WorkbenchBrowserApp.tsx",
  "app/WorkbenchBrowserLogForwarder.ts",
  "app/WorkbenchDesktopLauncher.ts",
]);

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
    outputDirectoryPath: "C:/workbench-output",
    startWatching: async () => "C:/workbench-output",
  } as WorkbenchFrontendCompiler;
  const database = {
    close: () => {},
    start: () => "registration",
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
    logger: new WorkbenchAppLogger({ color: false, writeError: () => {}, writeOutput: () => {} }),
    outputDirectoryPath: "C:/workbench-output",
    repositoryRootPath: "C:/repo",
  });
}

async function appProductionSourcePaths() {
  const sourcePaths: string[] = [];
  const visit = async (directoryPath: string, relativeDirectoryPath = ""): Promise<void> => {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
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
    .filter((sourcePath) => !nonServerSourcePaths.has(sourcePath))
    .filter((sourcePath) => owners(sourcePath).length === 0);
  assert.deepEqual(unownedServerSources, []);
  assert.deepEqual(
    sourcePaths.filter((sourcePath) => nonServerSourcePaths.has(sourcePath) && owners(sourcePath).length > 0),
    [],
  );

  assert.deepEqual(owners("app/state/WorkbenchAppStateRepository.ts"), ["client:database"]);
  assert.deepEqual(owners("app/state/WorkbenchAppStateController.ts"), ["client:state"]);
  assert.deepEqual(owners("app/runtime/WorkbenchAppHttpRouter.ts"), ["client:http"]);
  assert.deepEqual(owners("app/WorkbenchFrontendCompiler.ts"), ["client:compiler"]);
  assert.deepEqual(owners("app/runtime/AppHttpNode.ts"), ["client:http", "client:topology"]);
  assert.deepEqual(owners("app/index.ts"), ["client:process"]);
  assert.deepEqual(owners("app/app-command-line.ts"), ["client:process"]);
  assert.deepEqual(owners("app/package.json"), ["client:process"]);
  assert.deepEqual(owners("app/tsconfig.json"), ["client:process"]);
  assert.deepEqual(owners("package.json"), ["client:process"]);
  assert.deepEqual(owners("shared/http/StaticHttpRequestController.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/workbench-app-port.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/workbench-app-settings.ts"), ["client:http"]);
  assert.deepEqual(owners("shared/http/HttpServer.ts"), ["client:process"]);
  assert.deepEqual(owners("shared/state/workbench-app-state-schema.ts"), ["client:database"]);
  assert.deepEqual(owners("shared/package.json"), ["client:process"]);
  assert.deepEqual(owners("tray/src/main.rs"), ["client:process"]);
  assert.deepEqual(owners("tray/bin/windows-x64/workbench-tray.exe"), ["client:process"]);
  assert.deepEqual(owners("tray/target/release/workbench-tray.exe"), []);
});

test("reloads the database with a fresh repository constructor and no process restart", async (context) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "workbench-app-runtime-reload-"));
  context.after(async () => await rm(rootPath, { force: true, recursive: true }));
  const outputDirectoryPath = path.join(rootPath, "output");
  const databasePath = path.join(rootPath, "app-state.sqlite3");
  await Promise.all(["app", "shared", "static", "tray"].map(async (directory) => {
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
    createCompiler: (readReactDevelopmentMode) => {
      return {
        close: async () => {},
        outputDirectoryPath,
        startWatching: async () => {
          compilerModes.push(readReactDevelopmentMode());
          return outputDirectoryPath;
        },
      } as WorkbenchFrontendCompiler;
    },
    createDatabase: (Repository) => {
      constructors.push(Repository);
      const generation = constructors.length;
      const repository = new Repository({ databasePath });
      const close = repository.close.bind(repository);
      const start = repository.start.bind(repository);
      repository.close = () => {
        databaseEvents.push(`close:${generation}`);
        close();
      };
      repository.start = () => {
        databaseEvents.push(`start:${generation}`);
        return start();
      };
      return repository;
    },
    logger: new WorkbenchAppLogger({
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
  } finally {
    if (started) await target.close();
  }
});

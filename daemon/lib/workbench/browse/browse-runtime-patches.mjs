/*
 * Runtime helpers:
 * - installHiddenChildProcessDefaults: keep helper windows hidden without suppressing deliberate headed browser windows.
 * - patchBrowseRuntime: install Workbench download, persistent-profile, and graceful browser-close behavior on Browse/Stagehand.
 * Keywords: browse, runtime, windows, downloads, profile, shutdown.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function installHiddenChildProcessDefaults(argv = process.argv) {
  const originals = {
    exec: childProcess.exec,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    execSync: childProcess.execSync,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
  };
  const allowHeaded = shouldAllowHeadedBrowserWindows(argv);
  const hidden = (command, options) => process.platform === "win32" && !(allowHeaded && isLikelyBrowserExecutable(command))
    ? { ...(options ?? {}), windowsHide: true }
    : options;
  childProcess.spawn = function spawn(command, args, options) {
    return Array.isArray(args) ? originals.spawn.call(this, command, args, hidden(command, options)) : originals.spawn.call(this, command, hidden(command, args));
  };
  childProcess.spawnSync = function spawnSync(command, args, options) {
    return Array.isArray(args) ? originals.spawnSync.call(this, command, args, hidden(command, options)) : originals.spawnSync.call(this, command, hidden(command, args));
  };
  childProcess.exec = function exec(command, options, callback) {
    return typeof options === "function"
      ? originals.exec.call(this, command, hidden(command, undefined), options)
      : originals.exec.call(this, command, hidden(command, options), callback);
  };
  childProcess.execFile = function execFile(file, args, options, callback) {
    if (typeof args === "function") return originals.execFile.call(this, file, [], hidden(file, undefined), args);
    if (!Array.isArray(args)) return originals.execFile.call(this, file, [], hidden(file, args), options);
    return typeof options === "function"
      ? originals.execFile.call(this, file, args, hidden(file, undefined), options)
      : originals.execFile.call(this, file, args, hidden(file, options), callback);
  };
  childProcess.execFileSync = function execFileSync(file, args, options) {
    return Array.isArray(args) ? originals.execFileSync.call(this, file, args, hidden(file, options)) : originals.execFileSync.call(this, file, [], hidden(file, args));
  };
  childProcess.execSync = function execSync(command, options) {
    return originals.execSync.call(this, command, hidden(command, options));
  };
  syncBuiltinESMExports();
}

export async function patchBrowseRuntime() {
  const require = createRequire(import.meta.url);
  const browseBinPath = require.resolve("browse/bin/run.js");
  const browseRequire = createRequire(pathToFileURL(browseBinPath));
  const browseRoot = path.dirname(browseRequire.resolve("browse/package.json"));
  const stagehandRoot = path.dirname(browseRequire.resolve("@browserbasehq/stagehand/package.json"));
  const sessionManagerModule = await import(pathToFileURL(path.join(browseRoot, "dist", "lib", "driver", "session-manager.js")).href);
  const contextModule = await import(pathToFileURL(path.join(stagehandRoot, "dist", "esm", "lib", "v3", "understudy", "context.js")).href);
  patchLaunchOptions(sessionManagerModule);
  patchPersistentProfileShutdown(contextModule);
  return { browseRequire, browseRoot };
}

function patchLaunchOptions(sessionManagerModule) {
  const downloadsPath = process.env.WORKBENCH_BROWSE_DOWNLOADS_PATH?.trim();
  const userDataDir = process.env.WORKBENCH_BROWSE_USER_DATA_DIR?.trim();
  if (!downloadsPath && !userDataDir) return;
  const prototype = sessionManagerModule.DriverSessionManager?.prototype;
  if (!prototype || typeof prototype.stagehandOptions !== "function" || prototype.stagehandOptions.workbenchPatched) return;
  const original = prototype.stagehandOptions;
  const patched = async function stagehandOptions(...args) {
    const options = await original.apply(this, args);
    const [target] = args;
    if (target?.kind === "managed-local" && options?.env === "LOCAL") {
      if (userDataDir) fs.mkdirSync(userDataDir, { recursive: true });
      options.localBrowserLaunchOptions = {
        ...(options.localBrowserLaunchOptions ?? {}),
        ...(downloadsPath ? { acceptDownloads: true, downloadsPath } : {}),
        ...(userDataDir ? { preserveUserDataDir: true, userDataDir } : {}),
      };
    }
    return options;
  };
  patched.workbenchPatched = true;
  prototype.stagehandOptions = patched;
}

function patchPersistentProfileShutdown(contextModule) {
  const userDataDir = process.env.WORKBENCH_BROWSE_USER_DATA_DIR?.trim();
  if (!userDataDir) return;
  const prototype = contextModule.V3Context?.prototype;
  if (!prototype || typeof prototype.close !== "function" || prototype.close.workbenchPatched) return;
  const original = prototype.close;
  const patched = async function close(...args) {
    if (this?.localBrowserLaunchOptions?.userDataDir === userDataDir) await requestBrowserClose(this.conn);
    return original.apply(this, args);
  };
  patched.workbenchPatched = true;
  prototype.close = patched;
}

async function requestBrowserClose(connection) {
  if (!connection || typeof connection.send !== "function") return;
  try {
    await Promise.race([connection.send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  } catch {
    // Browser.close commonly closes CDP before returning.
  }
}

function shouldAllowHeadedBrowserWindows(argv) {
  if (argv.includes("--headed")) return true;
  const targetIndex = argv.indexOf("--target");
  try {
    const target = targetIndex >= 0 ? JSON.parse(argv[targetIndex + 1] ?? "") : null;
    return target?.kind === "managed-local" && target.headless === false;
  } catch {
    return false;
  }
}

function isLikelyBrowserExecutable(command) {
  return ["chrome.exe", "chromium.exe", "msedge.exe", "brave.exe", "brave-browser.exe", "vivaldi.exe", "opera.exe"]
    .includes(path.basename(String(command ?? "")).toLowerCase());
}

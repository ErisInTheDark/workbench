/*
 * Runtime wrapper:
 * - Forces child_process spawn/exec helpers to default windowsHide=true before Browse loads.
 * - Injects Workbench-owned local Browse download and persistent-profile defaults before Browse loads.
 * - Gives persistent local profiles a graceful Chrome shutdown path before Stagehand's kill fallback.
 * - Runs the project-local Browse oclif entrypoint without patching node_modules.
 * Keywords: browse, cli, windows, hidden, daemon, downloads, profile, cookies.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
const originalExec = childProcess.exec;
const originalExecFile = childProcess.execFile;
const originalExecFileSync = childProcess.execFileSync;
const originalExecSync = childProcess.execSync;
const allowHeadedBrowserWindows = shouldAllowHeadedBrowserWindows(process.argv);

childProcess.spawn = function spawnWithHiddenWindows(command, args, options) {
  if (Array.isArray(args)) {
    return originalSpawn.call(this, command, args, hideWindows(command, options));
  }
  return originalSpawn.call(this, command, hideWindows(command, args));
};

childProcess.spawnSync = function spawnSyncWithHiddenWindows(command, args, options) {
  if (Array.isArray(args)) {
    return originalSpawnSync.call(this, command, args, hideWindows(command, options));
  }
  return originalSpawnSync.call(this, command, hideWindows(command, args));
};

childProcess.exec = function execWithHiddenWindows(command, options, callback) {
  if (typeof options === "function") {
    return originalExec.call(this, command, hideWindows(command, undefined), options);
  }
  return originalExec.call(this, command, hideWindows(command, options), callback);
};

childProcess.execFile = function execFileWithHiddenWindows(file, args, options, callback) {
  if (typeof args === "function") {
    return originalExecFile.call(this, file, [], hideWindows(file, undefined), args);
  }
  if (!Array.isArray(args)) {
    if (typeof options === "function") {
      return originalExecFile.call(this, file, [], hideWindows(file, args), options);
    }
    return originalExecFile.call(this, file, [], hideWindows(file, args), options);
  }
  if (typeof options === "function") {
    return originalExecFile.call(this, file, args, hideWindows(file, undefined), options);
  }
  return originalExecFile.call(this, file, args, hideWindows(file, options), callback);
};

childProcess.execFileSync = function execFileSyncWithHiddenWindows(file, args, options) {
  if (Array.isArray(args)) {
    return originalExecFileSync.call(this, file, args, hideWindows(file, options));
  }
  return originalExecFileSync.call(this, file, [], hideWindows(file, args));
};

childProcess.execSync = function execSyncWithHiddenWindows(command, options) {
  return originalExecSync.call(this, command, hideWindows(command, options));
};

syncBuiltinESMExports();

globalThis.oclif = {
  ...globalThis.oclif,
  enableAutoTranspile: false,
};

const require = createRequire(import.meta.url);
const browseBinPath = require.resolve("browse/bin/run.js");
const browseRequire = createRequire(pathToFileURL(browseBinPath));
const browsePackageJsonPath = browseRequire.resolve("browse/package.json");
const browsePackageRoot = path.dirname(browsePackageJsonPath);
const stagehandPackageJsonPath = browseRequire.resolve("@browserbasehq/stagehand/package.json");
const stagehandPackageRoot = path.dirname(stagehandPackageJsonPath);
const sessionManagerModule = await import(pathToFileURL(path.join(browsePackageRoot, "dist", "lib", "driver", "session-manager.js")).href);
const contextModule = await import(pathToFileURL(path.join(stagehandPackageRoot, "dist", "esm", "lib", "v3", "understudy", "context.js")).href);
patchBrowseLocalLaunchOptions(sessionManagerModule);
patchBrowsePersistentProfileShutdown(contextModule);

const { execute } = await import(pathToFileURL(browseRequire.resolve("@oclif/core")).href);
await execute({ dir: pathToFileURL(browseBinPath).href });

function hideWindows(command, options) {
  return process.platform === "win32" && !shouldLeaveWindowVisible(command)
    ? { ...(options ?? {}), windowsHide: true }
    : options;
}

function shouldLeaveWindowVisible(command) {
  return allowHeadedBrowserWindows && isLikelyBrowserExecutable(command);
}

function isLikelyBrowserExecutable(command) {
  const executableName = path.basename(String(command ?? "")).toLowerCase();
  return executableName === "chrome.exe"
    || executableName === "chromium.exe"
    || executableName === "msedge.exe"
    || executableName === "brave.exe"
    || executableName === "brave-browser.exe"
    || executableName === "vivaldi.exe"
    || executableName === "opera.exe";
}

function shouldAllowHeadedBrowserWindows(argv) {
  if (argv.includes("--headed")) {
    return true;
  }

  const targetIndex = argv.indexOf("--target");
  if (targetIndex < 0) {
    return false;
  }

  const targetJson = argv[targetIndex + 1];
  if (!targetJson) {
    return false;
  }

  try {
    const target = JSON.parse(targetJson);
    return target?.kind === "managed-local" && target.headless === false;
  } catch {
    return false;
  }
}

function patchBrowseLocalLaunchOptions(sessionManagerModule) {
  const downloadsPath = process.env.WORKBENCH_BROWSE_DOWNLOADS_PATH?.trim();
  const userDataDir = process.env.WORKBENCH_BROWSE_USER_DATA_DIR?.trim();
  if (!downloadsPath && !userDataDir) {
    return;
  }

  const prototype = sessionManagerModule.DriverSessionManager?.prototype;
  if (!prototype || typeof prototype.stagehandOptions !== "function") {
    return;
  }

  const originalStagehandOptions = prototype.stagehandOptions;
  prototype.stagehandOptions = async function stagehandOptionsWithWorkbenchDownloadsPath(...args) {
    const options = await originalStagehandOptions.apply(this, args);
    const [target] = args;

    if (target?.kind === "managed-local" && options?.env === "LOCAL") {
      if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }

      options.localBrowserLaunchOptions = {
        ...(options.localBrowserLaunchOptions ?? {}),
        ...(downloadsPath ? {
          acceptDownloads: true,
          downloadsPath,
        } : {}),
        ...(userDataDir ? {
          preserveUserDataDir: true,
          userDataDir,
        } : {}),
      };
    }

    return options;
  };
}

function patchBrowsePersistentProfileShutdown(contextModule) {
  const userDataDir = process.env.WORKBENCH_BROWSE_USER_DATA_DIR?.trim();
  if (!userDataDir) {
    return;
  }

  const prototype = contextModule.V3Context?.prototype;
  if (!prototype || typeof prototype.close !== "function") {
    return;
  }

  const originalClose = prototype.close;
  prototype.close = async function closeWithPersistentProfileFlush(...args) {
    if (this?.localBrowserLaunchOptions?.userDataDir === userDataDir) {
      await requestBrowserClose(this.conn);
    }

    return originalClose.apply(this, args);
  };
}

async function requestBrowserClose(connection) {
  if (!connection || typeof connection.send !== "function") {
    return;
  }

  try {
    await Promise.race([
      connection.send("Browser.close"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch {
    // Browser.close often closes the CDP transport before a response returns.
  }
}

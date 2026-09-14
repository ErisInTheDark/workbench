/*
 * Runtime entrypoint:
 * - Load Workbench Browse patches and run one long-lived Browse session daemon without Oclif.
 * Keywords: browse, daemon, session, runtime.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

import { installHiddenChildProcessDefaults, patchBrowseRuntime } from "./browse-runtime-patches.mjs";

installHiddenChildProcessDefaults(process.argv);
const sessionIndex = process.argv.indexOf("--session");
const targetIndex = process.argv.indexOf("--target");
const session = sessionIndex >= 0 ? process.argv[sessionIndex + 1]?.trim() : "";
const rawTarget = targetIndex >= 0 ? process.argv[targetIndex + 1] : "";
if (!session || !rawTarget) throw new Error("Browse daemon requires --session and --target.");
const target = JSON.parse(rawTarget);
const { browseRoot } = await patchBrowseRuntime();
const daemonModule = await import(pathToFileURL(path.join(browseRoot, "dist", "lib", "driver", "daemon", "server.js")).href);
await daemonModule.runDriverDaemon({ session, target });

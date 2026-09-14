/*
 * Runtime wrapper:
 * - Load Workbench Browse process patches, then run the project-local Browse Oclif entrypoint for explicitly enabled raw compatibility only.
 * Keywords: browse, raw, cli, windows, downloads, profile.
 */
import { pathToFileURL } from "node:url";

import { installHiddenChildProcessDefaults, patchBrowseRuntime } from "./browse-runtime-patches.mjs";

installHiddenChildProcessDefaults(process.argv);
globalThis.oclif = { ...globalThis.oclif, enableAutoTranspile: false };
const { browseRequire } = await patchBrowseRuntime();
const { execute } = await import(pathToFileURL(browseRequire.resolve("@oclif/core")).href);
await execute({ dir: pathToFileURL(browseRequire.resolve("browse/bin/run.js")).href });

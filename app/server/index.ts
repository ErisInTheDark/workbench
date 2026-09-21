/*
 * No exports. Load the app process through the same discoverable module graph as its reloadable nodes.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { default: start } = require("./WorkbenchAppProcess.ts") as typeof import("./WorkbenchAppProcess.ts");
void start();

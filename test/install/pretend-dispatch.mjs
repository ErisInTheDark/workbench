/*
 * No exports. Install-sandbox overlay for package/dispatch.mjs: host-level human commands only pretend; others reach the checkout CLI.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const view = args[0] === "view" && (args.length === 1 || args.length === 2 && ["daemon", "app"].includes(args[1]));
const command = view ? "view" : args.length === 0 ? "start" : args.length === 1 ? args[0] : null;
const pretend = {
  start: "launching the Workbench app (and its daemon)",
  shortcut: "adding a desktop shortcut",
  connect: "enabling the wake service",
  disconnect: "disabling the wake service",
  view: `opening the ${args[1] ?? "process"} view`,
};

if (Object.hasOwn(pretend, command)) {
  process.stdout.write(`[install sandbox] pretending: ${pretend[command]}\n`);
} else {
  try {
    // Resolved where InstallSandbox copies this overlay: the snapshot's package/dispatch.mjs.
    const { default: SetupCommand } = await import(new URL("./SetupCommand.mjs", import.meta.url).href);
    await new SetupCommand().run("bash", [path.join(root, "wb"), ...args]); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

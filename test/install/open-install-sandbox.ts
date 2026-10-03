/*
 * No exports. `pnpm sandbox:install`: open an interactive shell where wb is uninstalled and the real installer runs inside a throwaway home.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import InstallSandbox from "./InstallSandbox.ts";

// The root package is CommonJS to tsx, so this entry cannot use top-level await.
async function main() {
  const keep = process.argv.slice(2).includes("--keep");
  if (process.env.WORKBENCH_THREAD_ID || process.env.CODEX_THREAD_ID) {
    throw new Error("The install sandbox is an interactive human tool; managed threads use pnpm test:install.");
  }

  const sandbox = await InstallSandbox.create({ write: text => process.stdout.write(text) });
  process.stdout.write([
    "",
    `Install sandbox: ${sandbox.root}`,
    "  real:    npm wb package, git clone of your working tree, vp runtime/dependencies/build, global CLI registration",
    "  pretend: wake service, desktop shortcut, app launch, process view",
    "  isolated: HOME, AppData, VP_HOME, npm prefix, pnpm home (pnpm store is shared with the host)",
    "Run `wb` to start. Exit the shell to " + (keep ? "leave the sandbox in place." : "delete the sandbox."),
    "",
  ].join("\n"));

  const windows = process.platform === "win32";
  const shell = windows ? "pwsh" : process.env.SHELL || "bash";
  // -NoProfile keeps profile scripts from putting the host wb back on PATH.
  const shellArgs = windows ? ["-NoLogo", "-NoProfile", "-NoExit", "-Command",
    "function global:prompt { \"[wb-sandbox] $($PWD.Path)> \" }"] : [];
  const child = spawn(shell, shellArgs, {
    cwd: sandbox.home,
    env: windows ? sandbox.environment : { ...sandbox.environment, PS1: "[wb-sandbox] \\w$ " },
    stdio: "inherit",
  });
  // The shell owns Ctrl+C while it runs; this process only waits to clean up.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  let failure: unknown = null;
  try { await once(child, "exit"); }
  catch (error) { failure = error; }
  process.off("SIGINT", ignore);

  if (keep) process.stdout.write(`Sandbox kept: ${sandbox.root}\n`);
  else {
    try { await sandbox.dispose(); }
    catch (error) {
      process.stderr.write(`Could not fully delete ${sandbox.root}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
  if (failure) throw failure;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

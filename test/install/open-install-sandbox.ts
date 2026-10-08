/*
 * No exports. `pnpm sandbox:install [--cmd] [--keep]`: open an interactive shell (bash, or cmd on Windows with --cmd)
 * where wb is uninstalled and the real installer runs inside a throwaway home.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import WorkbenchBootstrapCommand from "../../package/WorkbenchBootstrapCommand.mjs";
import InstallSandbox from "./InstallSandbox.ts";

// The root package is CommonJS to tsx, so this entry cannot use top-level await.
async function main() {
  const flags = process.argv.slice(2);
  const keep = flags.includes("--keep");
  const cmd = flags.includes("--cmd");
  if (cmd && process.platform !== "win32") throw new Error("--cmd is only available on Windows.");
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
    `Run \`wb\` to start. Type \`exit\` to leave and ${keep ? "keep" : "delete"} the sandbox (Ctrl+C only cancels the current command).`,
    "",
  ].join("\n"));

  const windows = process.platform === "win32";
  // Windows opens the same Git Bash wb resolves; skipping rc files keeps the host wb off PATH.
  const [shell, ...shellArgs] = cmd ? ["cmd", "/k", "prompt [wb-sandbox] $P$G"]
    : windows ? [...await new WorkbenchBootstrapCommand({ environment: sandbox.environment }).resolve("bash"), "--noprofile", "--norc", "-i"]
    : [process.env.SHELL || "bash"];
  const child = spawn(shell!, shellArgs, {
    cwd: sandbox.home,
    env: { ...sandbox.environment, PS1: "[wb-sandbox] \\w$ " },
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

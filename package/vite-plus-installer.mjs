/*
 * Exports:
 * - default installVitePlus: execute the pinned official installer without user shell integration.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const VITE_PLUS_VERSION = "1.1.0";

export default async function installVitePlus({
  home, directory, commands, onOutput, fetchInstaller = fetch, platform = process.platform, files = fs,
}) {
  const windows = platform === "win32";
  const extension = windows ? "ps1" : "sh";
  const url = `https://raw.githubusercontent.com/voidzero-dev/vite-plus/v${VITE_PLUS_VERSION}/packages/cli/install.${extension}`;
  const response = await fetchInstaller(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Vite+ installer download failed (HTTP ${response.status}).`);
  }
  const script = await response.text();
  if (!script.trim()) throw new Error("Vite+ installer download was empty.");
  await files.mkdir(directory, { recursive: true });
  const filename = path.join(directory, `vite-plus-${randomUUID()}.${extension}`);
  await files.writeFile(filename, script, { flag: "wx", mode: 0o600 });
  let failure;
  try {
    const environment = Object.fromEntries(Object.keys(commands.environment)
      .filter(name => /^VP_/iu.test(name)).map(name => [name, undefined]));
    Object.assign(environment, {
      VP_HOME: home,
      VP_VERSION: VITE_PLUS_VERSION,
      VP_NODE_MANAGER: "yes",
      VP_PM_MANAGER: "yes",
      // Release-pinned self-setup honours this on Unix and Windows; CI alone still edits profiles.
      VP_SELF_SETUP_NO_MODIFY_PATH: "1",
      CI: "true",
    });
    await commands.run(windows ? "powershell.exe" : "bash",
      windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filename] : [filename],
      { cwd: directory, environment, onOutput });
  } catch (error) {
    failure = error;
  }
  try { await files.unlink(filename); }
  catch (error) {
    if (failure) throw new AggregateError([failure, error], `Vite+ setup failed and its downloaded script could not be removed: ${filename}`, { cause: failure });
    throw error;
  }
  if (failure) throw failure;
}

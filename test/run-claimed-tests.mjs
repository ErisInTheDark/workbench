/* No exports. Local claimed-test entry preserves caller cwd and runner exit status. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();
process.chdir(path.join(root, "daemon"));
try {
  const { default: ClaimedProjectTestCommand } = await import("./ClaimedProjectTestCommand.ts");
  const result = await new ClaimedProjectTestCommand(root, { cwd }).run(process.argv.slice(2));
  if (result.signal !== null) process.kill(process.pid, result.signal);
  else process.exitCode = result.exitCode ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

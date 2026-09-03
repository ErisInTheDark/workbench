/*
 * Temporary one-shot request for a reload-owned reset of disposable transcript shadow data. Keywords: sqlite, reset, shadow, transcript.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIRMATION_FLAG = "--confirm-transcript-shadow-reset";
const RESET_REQUEST = "workbench-transcript-shadow-reset-v2\n";
const RESET_REQUEST_FILE_NAME = "reset-workbench-sqlite";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== CONFIRMATION_FLAG) {
    fail(`Refusing transcript shadow reset. Run with exactly ${CONFIRMATION_FLAG}.`);
    return;
  }

  const daemonRoot = path.resolve(process.cwd());
  if (path.basename(daemonRoot).toLowerCase() !== "daemon") {
    fail("Refusing transcript shadow reset outside the Workbench daemon directory.");
    return;
  }

  const storageRoot = path.join(path.dirname(daemonRoot), ".workbench");
  const requestPath = path.join(storageRoot, RESET_REQUEST_FILE_NAME);
  await mkdir(storageRoot, { recursive: true });
  try {
    const existing = await readFile(requestPath, "utf8");
    if (existing !== RESET_REQUEST) {
      fail(`Refusing to replace an unexpected transcript reset request: ${requestPath}`);
      return;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      fail(`Transcript reset request failed for ${requestPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      await writeFile(requestPath, RESET_REQUEST, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      fail(`Transcript reset request failed for ${requestPath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      return;
    }
  }

  process.stdout.write(`Transcript shadow reset requested: ${requestPath}\n`);
}

await main();

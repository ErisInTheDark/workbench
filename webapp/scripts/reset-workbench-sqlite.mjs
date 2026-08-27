/*
 * Temporary one-shot reset request for the disposable pre-authority Workbench SQLite database. Keywords: sqlite, reset, shadow.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIRMATION_FLAG = "--confirm-shadow-reset";
const RESET_REQUEST = "workbench-sqlite-shadow-reset-v1\n";
const RESET_REQUEST_FILE_NAME = "reset-workbench-sqlite";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== CONFIRMATION_FLAG) {
    fail(`Refusing SQLite shadow reset. Run with exactly ${CONFIRMATION_FLAG}.`);
    return;
  }

  const webappRoot = path.resolve(process.cwd());
  if (path.basename(webappRoot).toLowerCase() !== "webapp") {
    fail("Refusing SQLite shadow reset outside the Workbench webapp directory.");
    return;
  }

  const storageRoot = path.join(path.dirname(webappRoot), ".workbench");
  const requestPath = path.join(storageRoot, RESET_REQUEST_FILE_NAME);
  await mkdir(storageRoot, { recursive: true });
  try {
    const existing = await readFile(requestPath, "utf8");
    if (existing !== RESET_REQUEST) {
      fail(`Refusing to replace an unexpected SQLite reset request: ${requestPath}`);
      return;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      fail(`SQLite reset request failed for ${requestPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    try {
      await writeFile(requestPath, RESET_REQUEST, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      fail(`SQLite reset request failed for ${requestPath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      return;
    }
  }

  process.stdout.write(`SQLite shadow reset requested: ${requestPath}\n`);
}

await main();

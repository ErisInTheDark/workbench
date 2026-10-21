/*
 * No exports. Protects that `wb view` loads with Node's native type stripping and built-ins only, so it works while a
 * dependency repair has node_modules in flux.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const BLOCK_DEPENDENCIES = `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (!/^(node:|\\.{1,2}\\/|\\/|file:|[A-Za-z]:)/u.test(specifier)) throw new Error("dependency import: " + specifier);
  return next(specifier, context);
} });
`;

test("the process view's module graph loads without tsx or installed dependencies", async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "process-view.ts");
  const run = promisify(execFile)(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import", `data:text/javascript,${encodeURIComponent(BLOCK_DEPENDENCIES)}`,
    entry,
  ], { env: { ...process.env, NODE_OPTIONS: "", WORKBENCH_THREAD_ID: "process-view-load-test" } });
  // Every static import evaluates before main, which then refuses managed threads.
  await assert.rejects(run, (error: Error & { stderr: string }) => {
    assert.match(error.stderr, /human-only/u);
    return true;
  });
});

/*
 * No exports. Compile the static frontend once and retire compiler resources.
 */
import WorkbenchFrontendCompiler from "./WorkbenchFrontendCompiler.ts";

const compiler = new WorkbenchFrontendCompiler();
try {
  console.log(await compiler.buildOnce());
} finally {
  await compiler.shutdown();
}

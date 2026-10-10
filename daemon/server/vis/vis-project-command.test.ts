/* No production exports. Protect literal argument quoting into `wb vis render`, and that only one delivery per open run is accepted. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { VisRenderRuns, visShellCommand } from "./vis-project-command";

test("arguments are quoted so shell syntax inside them is never interpreted, and output pipes into wb vis render", () => {
  const [, , windows] = visShellCommand(["node", "a b.mjs", "it's;$(x)"], "run-1", "win32");
  assert.ok(windows!.endsWith("& 'node' 'a b.mjs' 'it''s;$(x)' | wb vis render --run 'run-1'"));
  assert.deepEqual(visShellCommand(["node", "it's;$(x)"], "run-1", "linux", "/bin/zsh"),
    ["/bin/zsh", "-lc", "set -o pipefail; 'node' 'it'\\''s;$(x)' | wb vis render --run 'run-1'"]);
});

test("a run accepts one delivery while open, and nothing after it closes", () => {
  const runs = new VisRenderRuns();
  const run = runs.open();
  assert.equal(runs.accept("unknown", "x"), false);
  assert.equal(runs.accept(run.runId, "css"), true);
  assert.equal(runs.accept(run.runId, "again"), false);
  assert.equal(run.take(), "css");
  run.close();
  assert.equal(runs.accept(run.runId, "late"), false);
});

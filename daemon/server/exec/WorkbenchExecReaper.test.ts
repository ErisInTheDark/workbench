/* No production exports. Protect that the current generation's roots are recorded and forgotten, and only earlier generations' roots are reaped, by start time, through the sandbox. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexExecRootEvent } from "../CodexExecServer";
import type { ExecRootRecord } from "../database/exec/WorkbenchExecRootStore";
import WorkbenchExecReaper, { buildExecReapScript } from "./WorkbenchExecReaper";

function fixture(stale: ExecRootRecord[]) {
  let listener: ((event: CodexExecRootEvent) => void) | null = null;
  const writes: string[] = [];
  const runs: string[][] = [];
  const logs: string[] = [];
  const reaper = new WorkbenchExecReaper({
    executor: { generation: "now", onRoot: next => { listener = next; return () => { listener = null; }; } },
    store: {
      record: async root => { writes.push(`record ${root.processId} ${root.generation} ${root.pid}`); },
      forget: async processId => { writes.push(`forget ${processId}`); },
      takeStale: async current => { assert.equal(current, "now"); return stale; },
    },
    runSandboxed: async command => { runs.push(command); return { code: 0, stdout: "reaped 10\n" }; },
    root: "C:/data", platform: "win32", log: line => logs.push(line),
  });
  return { reaper, writes, runs, logs, emit: (event: CodexExecRootEvent) => listener?.(event), listening: () => listener !== null };
}

test("earlier generations' roots are reaped through the sandbox and this generation's are tracked", async () => {
  const f = fixture([{ processId: "a", generation: "old", pid: 10, startedAt: "133" }]);
  await f.reaper.start();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0]!.slice(0, 4), ["pwsh", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(f.runs[0]![4]!, /@\{ Id = 10; Start = '133' \}/u);
  assert.deepEqual(f.logs, ["Stopped 1 command(s) left running by an earlier executor."]);
  f.emit({ kind: "root", processId: "b", pid: 20, startedAt: "5" });
  f.emit({ kind: "settled", processId: "b" });
  await Promise.resolve();
  assert.deepEqual(f.writes, ["record b now 20", "forget b"]);
  f.reaper.dispose();
  assert.equal(f.listening(), false);
});

test("nothing is run when no earlier root survives", async () => {
  const f = fixture([]);
  await f.reaper.start();
  assert.deepEqual(f.runs, []);
  f.reaper.dispose();
});

test("the reap script compares start times and cannot be steered by stored text", () => {
  const script = buildExecReapScript([{ pid: 7, startedAt: "12'; Remove-Item x; '34" }]);
  assert.match(script, /@\{ Id = 7; Start = '1234' \}/u);
  assert.match(script, /StartTime\.ToFileTimeUtc\(\)\.ToString\(\) -eq \$target\.Start/u);
});

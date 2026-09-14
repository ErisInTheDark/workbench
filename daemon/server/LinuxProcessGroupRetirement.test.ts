/*
 * Keywords: linux, process group, retirement, failure, zombie.
 * No exports. Tests protect observed group retirement and fail-closed OS errors.
 */
import assert from "node:assert/strict";
import test from "node:test";

import LinuxProcessGroupRetirement from "./LinuxProcessGroupRetirement";

function systemError(code: string) {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

test("waits for live descendants after the leader exits but not for zombies or unrelated groups", async () => {
  const snapshots = [
    new Map([[101, "101 (leader) S 1 101"], [102, "102 (child with ) in name) S 101 101"]]),
    new Map([[102, "102 (child) S 1 101"]]),
    new Map([[102, "102 (child) Z 1 101"], [103, "103 (unrelated) S 1 999"]]),
  ];
  const signalled: { pid: number; signal: NodeJS.Signals }[] = [];
  let observation = 0;
  const retirement = new LinuxProcessGroupRetirement({
    signalGroup: (pid, signal) => { signalled.push({ pid, signal }); },
    listProcessIds: async () => [...snapshots[observation]!.keys()],
    readProcessStat: async (pid) => snapshots[observation]!.get(pid)!,
    waitForNextCheck: async () => { observation += 1; },
  });
  await retirement.retire(101);
  assert.equal(observation, 2);
  assert.deepEqual(signalled, [{ pid: 101, signal: "SIGKILL" }], "Force retirement cannot depend on cooperative signal handling");
});

test("only missing groups and disappeared proc entries are expected failures", async () => {
  await new LinuxProcessGroupRetirement({
    signalGroup: () => { throw systemError("ESRCH"); },
    listProcessIds: async () => { throw new Error("must not inspect a missing group"); },
  }).retire(101);
  await new LinuxProcessGroupRetirement({
    signalGroup: () => undefined,
    listProcessIds: async () => [101],
    readProcessStat: async () => { throw systemError("ENOENT"); },
  }).retire(101);
  for (const code of ["EPERM", "EIO"]) {
    await assert.rejects(new LinuxProcessGroupRetirement({
      signalGroup: () => { throw systemError(code); },
    }).retire(101), { code });
    await assert.rejects(new LinuxProcessGroupRetirement({
      signalGroup: () => undefined,
      listProcessIds: async () => [101],
      readProcessStat: async () => { throw systemError(code); },
    }).retire(101), { code });
  }
});

test("invalid identities and malformed observations cannot report retirement success", async () => {
  for (const pid of [0, 1, -101, 1.5, NaN, Infinity]) {
    await assert.rejects(new LinuxProcessGroupRetirement({
      signalGroup: () => { throw new Error("must not signal"); },
    }).retire(pid), /process group/u);
  }
  await assert.rejects(new LinuxProcessGroupRetirement({
    signalGroup: () => undefined,
    listProcessIds: async () => [101],
    readProcessStat: async () => "unreadable process state",
  }).retire(101), /process stat/u);
  await assert.rejects(new LinuxProcessGroupRetirement({
    signalGroup: () => undefined,
    listProcessIds: async () => { throw systemError("EACCES"); },
  }).retire(101), { code: "EACCES" });
});

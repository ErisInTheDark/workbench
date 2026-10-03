import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";

import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { captureTestOutput } from "../../test/capture-test-output.mts";
import CodexSandboxAclController, { type CodexSandboxAclCommandRunner, type CodexSandboxAclRunner } from "./CodexSandboxAclController";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-4444";
// Codex keys roots in lowercase, so repairs address that spelling of the root.
const ROOT = "c:\\repo";
const capabilities = JSON.stringify({ writable_root_by_path: { "c:/repo": SID } });
const rootAcl = [`${SID}:(OI)(CI)(M)`, "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)"];
const healthy = [`${SID}:(I)(M)`, "NT AUTHORITY\\SYSTEM:(I)(F)"];
const broken = ["NT AUTHORITY\\SYSTEM:(I)(F)"];

type Identity = "daemon" | "sandbox";
type FakeObject = { owner: Identity; lines: string[] };

function expectRepairLogs(context: TestContext) {
  captureTestOutput(context, process.stdout, (text) => text.startsWith("[codex-sandbox-acl] "));
  captureTestOutput(context, process.stderr, (text) => text.startsWith("[codex-sandbox-acl] "));
}

/**
 * In-memory Windows: an identity can re-inherit only objects it owns, and only from a parent that already carries the grant.
 * Repair commands are read back from the encoded walker so the fake honours its targets or whole-tree mode.
 */
function fakeWindows(objects: Record<string, FakeObject>) {
  const state = new Map(Object.entries(objects).map(([target, object]) => [target.toLowerCase(), object]));
  const passes: Array<{ identity: Identity; targets: string[] }> = [];
  const listing = (target: string, lines: string[]) => `${target} ${lines[0]}\n${lines.slice(1).map((line) => `     ${line}`).join("\n")}\n`;
  const carries = (target: string) => target === ROOT || Boolean(state.get(target)?.lines.some((line) => line.startsWith(`${SID}:(I)`)));
  const pass = (identity: Identity): CodexSandboxAclCommandRunner => async (command) => {
    const script = Buffer.from(command.at(-1)!, "base64").toString("utf16le");
    const targets = [...(/\$targets = @\((.*)\)/u.exec(script)?.[1] ?? "").matchAll(/'([^']*)'/gu)].map(([, value]) => value!.toLowerCase());
    passes.push({ identity, targets });
    const order = targets.length ? targets : [...state.keys()].filter((key) => key !== ROOT).sort();
    let found = 0;
    let fixed = 0;
    for (const target of order) {
      const object = state.get(target);
      if (!object || carries(target)) continue;
      found += 1;
      if (object.owner === identity && carries(path.win32.dirname(target))) {
        object.lines = healthy;
        fixed += 1;
      }
    }
    return { code: 0, stdout: `WBACL broken=${found} fixed=${fixed} failed=${found - fixed}\n` };
  };
  const reads: string[] = [];
  const runner: CodexSandboxAclRunner = {
    icacls: async ([target]) => {
      reads.push(target!);
      if (target!.endsWith("\\*")) {
        const parent = target!.slice(0, -2).toLowerCase();
        const children = [...state].filter(([candidate]) => path.win32.dirname(candidate) === parent);
        return { code: 0, stdout: children.map(([candidate, object]) => listing(candidate, object.lines)).join("\n") };
      }
      const object = state.get(target!.toLowerCase());
      return object ? { code: 0, stdout: listing(target!, object.lines) } : { code: 2, stdout: "" };
    },
    daemon: pass("daemon"),
  };
  return {
    passes, reads, runner, sandbox: pass("sandbox"), state,
    exists: async (target: string) => state.has(target.toLowerCase()),
    controller: (options: { platform?: NodeJS.Platform } = {}) => new CodexSandboxAclController({
      platform: options.platform ?? "win32", readCapabilities: async () => capabilities, runner, exists: async (target) => state.has(target.toLowerCase()),
    }),
  };
}

test("patch targets under sandbox-owned folders alternate identities until the whole chain inherits the grant", async (context) => {
  expectRepairLogs(context);
  const windows = fakeWindows({
    [ROOT]: { owner: "daemon", lines: rootAcl },
    [`${ROOT}\\std`]: { owner: "sandbox", lines: broken },
    [`${ROOT}\\std\\lib.rs`]: { owner: "daemon", lines: broken },
    [`${ROOT}\\docs`]: { owner: "sandbox", lines: broken },
  });
  const controller = windows.controller();
  await controller.ensureWritable([`${ROOT}\\std\\lib.rs`], new AbortController().signal, windows.sandbox);
  assert.deepEqual(windows.state.get(`${ROOT}\\std\\lib.rs`)?.lines, healthy);
  const urgent = windows.passes.filter(({ targets }) => targets.length);
  assert.deepEqual(urgent.map(({ identity }) => identity), ["sandbox", "daemon"], "the sandbox owner unblocks the folder, then the daemon owner fixes its file");
  assert.ok(urgent.every(({ targets }) => targets.join() === [`${ROOT}\\std`, `${ROOT}\\std\\lib.rs`].join()), "urgent passes cover only the target chain");
  await controller.idle();
  await controller.idle();
  assert.deepEqual(windows.state.get(`${ROOT}\\docs`)?.lines, healthy);
  const settled = windows.reads.length;
  await controller.ensureWritable([`${ROOT}\\docs\\a.md`], new AbortController().signal, windows.sandbox);
  assert.deepEqual(windows.reads.slice(settled), [ROOT], "a verified clean walk lets later patches skip chain reads");
  await controller.dispose();
});

test("a walk that leaves objects unwritable never marks the root healthy", async (context) => {
  expectRepairLogs(context);
  const windows = fakeWindows({
    [ROOT]: { owner: "daemon", lines: rootAcl },
    [`${ROOT}\\std`]: { owner: "sandbox", lines: broken },
  });
  const controller = windows.controller();
  await controller.ensureWritable([`${ROOT}\\std\\lib.rs`], new AbortController().signal);
  await controller.idle();
  assert.deepEqual(windows.state.get(`${ROOT}\\std`)?.lines, broken, "without the sandbox identity the owner-only object stays broken");
  assert.ok(windows.passes.length <= 4 && windows.passes.every(({ identity }) => identity === "daemon"));
  const before = windows.reads.length;
  await controller.ensureWritable([`${ROOT}\\std\\lib.rs`], new AbortController().signal, windows.sandbox);
  assert.ok(windows.reads.length > before + 1, "the unverified root is checked again");
  assert.deepEqual(windows.state.get(`${ROOT}\\std`)?.lines, healthy, "a later caller with the sandbox identity finishes the repair");
  await controller.idle();
  await controller.dispose();
});

test("background shell scans walk a root with orphaned children once, and leave clean roots alone", async (context) => {
  expectRepairLogs(context);
  const windows = fakeWindows({
    [ROOT]: { owner: "daemon", lines: rootAcl },
    [`${ROOT}\\scratch`]: { owner: "sandbox", lines: broken },
    [`${ROOT}\\target`]: { owner: "sandbox", lines: healthy },
  });
  const controller = windows.controller();
  controller.checkInBackground(ROOT, windows.sandbox);
  controller.checkInBackground(`${ROOT}\\scratch`, windows.sandbox);
  await controller.idle();
  assert.deepEqual(windows.state.get(`${ROOT}\\scratch`)?.lines, healthy);
  assert.deepEqual(windows.passes.map(({ identity, targets }) => [identity, targets.length]), [["sandbox", 0]], "one whole-tree walk, finished by the owner's pass");
  await controller.dispose();

  const clean = fakeWindows({
    [ROOT]: { owner: "daemon", lines: rootAcl },
    [`${ROOT}\\target`]: { owner: "sandbox", lines: healthy },
    [`${ROOT}\\opted-out`]: { owner: "daemon", lines: ["NT AUTHORITY\\SYSTEM:(F)"] },
  });
  const cleanController = clean.controller();
  cleanController.checkInBackground(ROOT, clean.sandbox);
  cleanController.checkInBackground(ROOT, clean.sandbox);
  await cleanController.idle();
  assert.deepEqual(clean.passes, []);
  assert.equal(clean.reads.filter((target) => target.endsWith("\\*")).length, 1, "a clean scan is not repeated");
  await cleanController.dispose();
});

test("a patch from another thread during an in-flight walk repairs its target without starting a second walk", async (context) => {
  expectRepairLogs(context);
  const windows = fakeWindows({
    [ROOT]: { owner: "daemon", lines: rootAcl },
    [`${ROOT}\\scratch`]: { owner: "daemon", lines: broken },
    [`${ROOT}\\src`]: { owner: "daemon", lines: broken },
    [`${ROOT}\\src\\lib.rs`]: { owner: "daemon", lines: broken },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const walking = new Promise<void>((resolve) => { started = resolve; });
  const daemon = windows.runner.daemon;
  const runner: CodexSandboxAclRunner = {
    ...windows.runner,
    daemon: async (command, root, signal) => {
      const script = Buffer.from(command.at(-1)!, "base64").toString("utf16le");
      if (script.includes("$targets = @()")) { started(); await gate; }
      return daemon(command, root, signal);
    },
  };
  const controller = new CodexSandboxAclController({ platform: "win32", readCapabilities: async () => capabilities, runner, exists: windows.exists });
  controller.checkInBackground(ROOT);
  await walking;
  await controller.ensureWritable([`${ROOT}\\src\\lib.rs`], new AbortController().signal);
  assert.deepEqual(windows.state.get(`${ROOT}\\src\\lib.rs`)?.lines, healthy, "the target is writable before the walk finishes");
  release();
  await controller.idle();
  assert.equal(windows.passes.filter(({ targets }) => !targets.length).length, 1, "the patch did not start a second walk");
  await controller.dispose();
});

test("other platforms never touch ACLs", async () => {
  const windows = fakeWindows({ [ROOT]: { owner: "daemon", lines: rootAcl }, [`${ROOT}\\src`]: { owner: "daemon", lines: broken } });
  const controller = windows.controller({ platform: "linux" });
  await controller.ensureWritable([`${ROOT}\\src\\a.rs`], new AbortController().signal, windows.sandbox);
  controller.checkInBackground(ROOT, windows.sandbox);
  await controller.idle();
  await controller.dispose();
  assert.deepEqual(windows.reads, []);
  assert.deepEqual(windows.passes, []);
});

function powershell(script: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, PSModulePath: undefined, ...env }, windowsHide: true,
    }, (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve());
  });
}

function icacls(target: string) {
  return new Promise<string>((resolve, reject) => {
    execFile("icacls.exe", [target], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// Codex's legacy root write: the root gains an inheritable grant but existing descendants never receive it.
const BREAK_INHERITANCE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WbAclRepro {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint r, out IntPtr sd, out uint len);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool SetFileSecurityW(string n, uint info, IntPtr sd);
  public static void Set(string path, string sddl) { IntPtr sd; uint len; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out len) || !SetFileSecurityW(path, 4, sd)) throw new Exception("repro failed " + Marshal.GetLastWin32Error()); }
}
'@
$sid = New-Object System.Security.Principal.SecurityIdentifier $env:WB_SID
$guardItem = New-Object System.IO.DirectoryInfo $env:WB_GUARD
$guard = $guardItem.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$guard.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Write', 'ContainerInherit,ObjectInherit', 'None', 'Deny')))
$guardItem.SetAccessControl($guard)
$acl = (New-Object System.IO.DirectoryInfo $env:WB_ROOT).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
[WbAclRepro]::Set($env:WB_ROOT, $acl.GetSecurityDescriptorSddlForm('Access'))
`;

test("real Windows ACLs: the walker restores an orphaned sandbox grant and keeps explicit denies", { skip: process.platform !== "win32" }, async (context) => {
  expectRepairLogs(context);
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-codex-sandbox-acl-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  const target = path.join(root, "src", "deep", "file.rs");
  const sibling = path.join(root, "scratch", "note.txt");
  const guard = path.join(root, ".git");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  await fs.mkdir(guard);
  await Promise.all([fs.writeFile(target, "x"), fs.writeFile(sibling, "y")]);
  await powershell(BREAK_INHERITANCE, { WB_SID: SID, WB_ROOT: root, WB_GUARD: guard });
  const inherits = async (candidate: string) => (await icacls(candidate)).includes(`${SID}:(I)`);
  assert.equal(await inherits(target), false, "repro must orphan the root grant");

  const controller = new CodexSandboxAclController({
    platform: "win32", readCapabilities: async () => JSON.stringify({ writable_root_by_path: { [root.replace(/\\/gu, "/").toLowerCase()]: SID } }),
  });
  await controller.ensureWritable([target], new AbortController().signal);
  assert.equal(await inherits(target), true, "urgent repair fixes the patch target before the hook returns");
  assert.equal(await inherits(sibling), false, "urgent repair stays on the target chain");
  await controller.idle();
  await controller.dispose();
  assert.equal(await inherits(sibling), true, "the background walk fixes the rest of the tree");
  assert.equal(await inherits(guard), true, "objects with explicit ACEs also regain the inherited grant");
  assert.match(await icacls(guard), new RegExp(`${SID}:\\(OI\\)\\(CI\\)\\(DENY\\)`, "u"), "explicit denies survive");
});

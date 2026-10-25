/* No exports. Protect the Node preload: held reads, hidden paths and Node descendants all see the arc tree. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import WorkbenchArcTree from "./WorkbenchArcTree.mjs";

const PROBE = `
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
const [directory, role] = process.argv.slice(2);
const at = name => path.join(directory, name);
const outcome = run => { try { run(); return "ok"; } catch (error) { return error.code; } };
console.log(JSON.stringify({
  held: fs.readFileSync(at("held.txt"), "utf8"),
  heldPromise: await readFile(at("held.txt"), "utf8"),
  plain: fs.readFileSync(at("plain.txt"), "utf8"),
  hiddenExists: fs.existsSync(at("hidden.txt")),
  hiddenStat: fs.statSync(at("hidden.txt"), { throwIfNoEntry: false }) ?? null,
  hiddenRead: outcome(() => fs.readFileSync(at("hidden.txt"))),
  listing: fs.readdirSync(directory).sort(),
  child: role === "child" ? null : (() => {
    const { status, stderr, stdout } = spawnSync(process.execPath, [import.meta.filename, directory, "child"], { encoding: "utf8" });
    return { held: status === 0 ? JSON.parse(stdout).held : null, stderr };
  })(),
}));
`;

test("node processes and their node children read held paths from the arc tree", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("arc-tree-preload-");
  t.after(() => temporary.dispose());
  const root = path.join(temporary.path, "repo");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "held.txt"), "live edit");
  await fs.writeFile(path.join(root, "hidden.txt"), "another thread's new file");
  await fs.writeFile(path.join(root, "plain.txt"), "plain");
  await fs.writeFile(path.join(root, "probe.mjs"), PROBE);
  await using tree = WorkbenchArcTree.fromFiles(root, new Map([["held.txt", Buffer.from("baseline")], ["hidden.txt", null]]));
  const environment = await tree.nodeEnvironment({ directory: path.join(temporary.path, "manifests") });

  const { stderr, stdout } = await promisify(execFile)(process.execPath, [path.join(root, "probe.mjs"), root], {
    env: { ...process.env, ...environment },
  });
  assert.equal(stderr, "", "the preload adds no warnings to processes callers watch");
  assert.deepEqual(JSON.parse(stdout), {
    held: "baseline",
    heldPromise: "baseline",
    plain: "plain",
    hiddenExists: false,
    hiddenStat: null,
    hiddenRead: "ENOENT",
    listing: ["held.txt", "plain.txt", "probe.mjs"],
    child: { held: "baseline", stderr: "" },
  });
});

/* No production exports. Tests protect gitignore enforcement, rg-compatible output, result guards, rejections, and worker cancellation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchRipgrepController from "./WorkbenchRipgrepController";

const runCommand = promisify(execFile);

async function withRepository(files: Record<string, string | Buffer>, body: (root: string) => Promise<void>) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-rg-");
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(temporary.path, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await runCommand("git", ["init", "-q"], { cwd: temporary.path });
    await body(temporary.path);
  } finally {
    await temporary.dispose();
  }
}

async function search(controller: WorkbenchRipgrepController, cwd: string, args: string[], signal = new AbortController().signal) {
  const response = await controller.execute({ args, cwd, harness: "codex" }, signal);
  return { status: response.status, text: await response.text() };
}

test("skips gitignored files even under explicit paths until --no-ignore", async () => {
  await withRepository({
    ".gitignore": "node_modules/\nsecret.txt\n",
    ".github/workflow.yml": "needle: true\n",
    "node_modules/pkg/index.js": "needle\n",
    "secret.txt": "needle\n",
    "src/a.ts": "const needle = 1;\n",
  }, async (root) => {
    const controller = new WorkbenchRipgrepController();
    assert.deepEqual(await search(controller, root, ["needle"]), {
      status: 200,
      text: ".github/workflow.yml\n1:needle: true\n\nsrc/a.ts\n1:const needle = 1;\n",
    });

    const namedDirectory = await search(controller, root, ["needle", "node_modules"]);
    assert.equal(namedDirectory.status, 200);
    assert.doesNotMatch(namedDirectory.text, /index\.js/u);
    assert.match(namedDirectory.text, /node_modules: no git-visible files/u);

    const namedFile = await search(controller, root, ["needle", "secret.txt"]);
    assert.doesNotMatch(namedFile.text, /1:needle/u);
    assert.match(namedFile.text, /secret\.txt: skipped because it is gitignored/u);

    assert.deepEqual(await search(controller, root, ["--no-ignore", "-l", "needle", "node_modules"]), {
      status: 200, text: "node_modules/pkg/index.js\n",
    });
    assert.deepEqual(await search(controller, root, ["-l", "-g", "*.ts", "needle"]), { status: 200, text: "src/a.ts\n" });
    assert.deepEqual(await search(controller, root, ["-l", "-t", "yaml", "needle"]), { status: 200, text: ".github/workflow.yml\n" });
  });
});

test("searches cwd without a path and prints rg-style context, invert, only-matching and counts", async () => {
  await withRepository({ "notes.txt": "alpha\nbeta\ngamma\ndelta\nbeta\n" }, async (root) => {
    const controller = new WorkbenchRipgrepController();
    const cases: Array<[string[], string]> = [
      [["-C1", "gamma"], "notes.txt\n2-beta\n3:gamma\n4-delta\n"],
      [["-A1", "beta"], "notes.txt\n2:beta\n3-gamma\n--\n5:beta\n"],
      [["-v", "-N", "beta"], "notes.txt\nalpha\ngamma\ndelta\n"],
      [["--no-heading", "-o", "-e", "b.ta", "-e", "g\\w+"], "notes.txt:2:beta\nnotes.txt:3:gamma\nnotes.txt:5:beta\n"],
      [["-c", "beta"], "notes.txt:2\n"],
      [["-i", "-l", "GAMMA"], "notes.txt\n"],
      [["no-such-text"], ""],
    ];
    for (const [args, expected] of cases) {
      assert.deepEqual(await search(controller, root, args), { status: 200, text: expected }, args.join(" "));
    }
  });
});

test("skips binary and oversized files and stops at the result cap with notices", async () => {
  await withRepository({
    "big.txt": "needle\n".repeat(10),
    "bin.dat": Buffer.from("needle\0\u0001"),
    "many.txt": "needle\n".repeat(5),
  }, async (root) => {
    const controller = new WorkbenchRipgrepController();
    const capped = await search(controller, root, ["--max-filesize", "50", "--max-results", "3", "needle"]);
    assert.equal(capped.status, 200);
    assert.ok(capped.text.startsWith("many.txt\n1:needle\n2:needle\n3:needle\n\n"), capped.text);
    assert.doesNotMatch(capped.text, /4:needle|bin\.dat|big\.txt\n/u);
    assert.match(capped.text, /output truncated at 3 results/u);
    assert.match(capped.text, /skipped 1 files over 50/u);

    assert.deepEqual(await search(controller, root, ["-a", "-l", "needle", "bin.dat"]), { status: 200, text: "bin.dat\n" });
  });
});

test("rejects unsupported flags, stdin, invalid regex and missing paths", async () => {
  await withRepository({ "a.txt": "needle\n" }, async (root) => {
    const controller = new WorkbenchRipgrepController();
    const cases: Array<[string[], RegExp]> = [
      [["--pre=convert", "needle"], /Unsupported flag --pre/u],
      [["-P", "needle"], /Unsupported flag -P/u],
      [["needle", "-"], /never reads stdin/u],
      [["(unclosed"], /Invalid regex/u],
      [["needle", "missing-dir"], /missing-dir: path not found/u],
    ];
    for (const [args, expected] of cases) {
      const response = await search(controller, root, args);
      assert.equal(response.status, 400, args.join(" "));
      assert.match(response.text, expected);
    }
  });
});

test("cancelling a live search terminates the worker and rejects with the caller's reason", async () => {
  await withRepository({ "slow.txt": `${"a".repeat(40)}!\n` }, async (root) => {
    const cancellation = new AbortController();
    const controller = new WorkbenchRipgrepController({
      onWorkerOnline: () => cancellation.abort(new Error("caller cancelled")),
    });
    // Catastrophic backtracking would never finish; only worker termination can end this search.
    await assert.rejects(search(controller, root, ["(a+)+$"], cancellation.signal), /caller cancelled/u);
  });
});

/* No exports. Protect typecheck overlays: held content, hidden paths and restored deletions shape diagnostics; untouched files read from disk. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory";
import ArcTreeOverlay from "./ArcTreeOverlay";
import { typecheckWithArcOverlay } from "./arc-overlay-typecheck";

test("typecheck reads held paths from the overlay and everything else from disk", async t => {
  const temporary = await WorkbenchTemporaryDirectory.create("arc-overlay-typecheck-");
  t.after(() => temporary.dispose());
  const root = temporary.path;
  const write = async (name: string, lines: string[]) => await fs.writeFile(path.join(root, name), lines.join("\n"));
  await write("tsconfig.json", [JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, include: ["*.ts"] })]);
  await write("main.ts", [
    "import { value } from \"./held\";",
    "import { restored } from \"./restored\";",
    "import { hidden } from \"./hidden\";",
    "export const sum = restored + hidden;",
    "export const total: number = value;",
  ]);
  await write("held.ts", ["export const value = 1;"]);
  await write("hidden.ts", ["export const hidden = 1;"]);
  await write("stray.ts", ["export const stray: number = \"another thread's new file\";"]);
  const overlay = ArcTreeOverlay.fromFiles(root, new Map([
    ["held.ts", Buffer.from("export const value: string = \"baseline\";\n")],
    ["restored.ts", Buffer.from("export const restored = 1;\n")],
    ["hidden.ts", null],
    ["stray.ts", null],
  ]), 1);

  const { code, output } = typecheckWithArcOverlay(root, "tsconfig.json", overlay);
  const reported = [...output.matchAll(/^(\S+)\((\d+),(\d+)\): error TS(\d+)/gmu)]
    .map(([, file, line, column, diagnostic]) => `${path.basename(file!)}:${line}:${column}:${diagnostic}`);
  assert.equal(code, 1);
  assert.deepEqual(reported, ["main.ts:3:24:2307", "main.ts:5:14:2322"]);
});

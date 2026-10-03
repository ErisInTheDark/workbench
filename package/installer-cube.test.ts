/*
 * No production exports. Tests that cube frames always fill the same fixed box so in-place redraws leave no ghosts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { INSTALLER_CUBE_ROWS, installerCubeWidth, renderInstallerCube } from "./installer-cube.mjs";

test("every frame is exactly rows lines of the advertised width in printable ASCII", () => {
  for (const rows of [INSTALLER_CUBE_ROWS.min, 16, INSTALLER_CUBE_ROWS.max]) {
    for (let seconds = 0; seconds < 8; seconds += 0.37) {
      const frame = renderInstallerCube(seconds, rows);
      assert.equal(frame.length, rows);
      for (const line of frame) {
        assert.equal(line.length, installerCubeWidth(rows));
        assert.match(line, /^[\x20-\x7e]*$/u);
      }
      assert.ok(frame.some(line => line.trim()), "the cube is visible");
    }
  }
});

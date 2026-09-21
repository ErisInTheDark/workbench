/* No production exports. Protect shortcut ownership without running desktop integration. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import LinuxDesktopShortcut from "./LinuxDesktopShortcut.ts";

test("shortcut installation refuses to overwrite an unrelated menu entry", async context => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wb-shortcut-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const dataHome = path.join(home, "data");
  const destination = path.join(dataHome, "applications", "inthedark-workbench.desktop");
  await mkdir(path.dirname(destination), { recursive: true });
  const original = "[Desktop Entry]\nType=Application\nName=Other application\n";
  await writeFile(destination, original);
  const shortcut = new LinuxDesktopShortcut({
    home, dataHome, root: path.join(home, "wb"), launcher: path.join(home, "wb/tray"),
    desktopDirectory: async () => "",
  });
  await assert.rejects(shortcut.install(), /unrelated/);
  assert.equal(await readFile(destination, "utf8"), original);
});

test("shortcut paths cannot inject additional desktop-entry fields", async context => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wb-shortcut-input-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const shortcut = new LinuxDesktopShortcut({
    home, dataHome: path.join(home, "data"), root: "/repo\nTerminal=true",
    launcher: "/launcher", desktopDirectory: async () => "",
  });
  await assert.rejects(shortcut.install(), /control characters/);
  await assert.rejects(readFile(path.join(home, "data/applications/inthedark-workbench.desktop")), { code: "ENOENT" });
});

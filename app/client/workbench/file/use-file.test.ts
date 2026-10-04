/*
 * No production exports. Protect file-open policy, concrete owner routing, and repo display identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { createProjectRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

import { FileActionContext, resolveFileOpenDestination, useFile, useFileActions, type FileOpenAction } from "./use-file";

test("file pills derive repo identity from the absolute target without rewriting opens", () => {
  const absolutePath = `/data/.cache/repos/mounts/github.com/openai/codex/${"a".repeat(40)}/src/file.ts`;
  let displayPrefix = "";
  const targets: Parameters<FileOpenAction>[0][] = [];
  const action: FileOpenAction = async target => { targets.push(target); return true; };
  function Harness() {
    const file = useFile({
      absolutePath, path: "file.ts", openPath: absolutePath,
      columnNumber: null, lineNumber: null, displayOptions: {}, projectId: null, targetType: "file",
    });
    displayPrefix = file.display.rootPrefix;
    file.open();
    return null;
  }
  renderToStaticMarkup(createElement(FileActionContext.Provider, { value: action }, createElement(Harness)));
  assert.equal(displayPrefix, "repo:codex:");
  assert.equal(targets[0]?.absolutePath, absolutePath);
  assert.equal(targets[0]?.path, absolutePath);
});

test("file-open policy preserves absolute and unsupported-file choices", () => {
  assert.equal(resolveFileOpenDestination({ path: "docs/a.md" }, "workbench"), "workbench");
  assert.equal(resolveFileOpenDestination({ path: "src/a.ts" }, "vscode"), "vscode");
  assert.equal(resolveFileOpenDestination({ path: "image.png" }, "workbench"), null);
  assert.equal(resolveFileOpenDestination({ path: "image.png" }, "workbench-or-vscode"), "vscode");
  assert.equal(resolveFileOpenDestination({ absolutePath: "C:/external/a.ts", path: "a.ts" }, "workbench"), "vscode");
});

test("file actions use the rendering panel owner across navigation and external opens", async () => {
  const opened: Array<{ path: string; projectId?: string | null }> = [];
  const wrongDaemonOpens: string[] = [];
  const navigated: WorkbenchRoute[] = [];
  let invalidLocations = 0;
  const remoteDaemon = {
    nativeFiles: { open: async (target: { path: string; projectId?: string | null }) => {
      opened.push(target);
      return { ok: true };
    } },
  } as WorkbenchDaemonClient;
  const defaultDaemon = {
    nativeFiles: { open: async ({ path }: { path: string }) => {
      wrongDaemonOpens.push(path);
      return { ok: true };
    } },
  } as WorkbenchDaemonClient;
  const action: { current: FileOpenAction | null } = { current: null };
  function Harness() {
    action.current = useFileActions({
      behavior: "workbench-or-vscode",
      browseLocation: null,
      currentProjectId: "browse-project",
      defaultDaemon,
      logicalProjects: [],
      navigateToRoute: route => { navigated.push(route); },
      onInvalidLocation: () => { invalidLocations += 1; },
      route: createProjectRoute("browse-project"),
      selectedDaemon: null,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  const open = action.current;
  assert.ok(open);
  const scope = {
    daemon: remoteDaemon,
    daemonId: "b74d1692-0f0f-4d93-818e-76825d8fa12a",
    projectId: "panel-project",
  };

  assert.equal(await open({ path: "docs/panel.md" }, scope), true);
  assert.equal(navigated[0]?.logical?.location?.daemonId, scope.daemonId);
  assert.equal(navigated[0]?.logical?.location?.projectId, "panel-project");
  assert.equal(await open({ absolutePath: "C:/outside/panel.ts", path: "panel.ts" }, scope), true);
  assert.equal(opened[0]?.projectId, "panel-project");
  assert.equal(opened[0]?.path, "panel.ts");
  assert.equal(invalidLocations, 0);
  assert.equal(await open({ absolutePath: "C:/outside/unavailable.ts", path: "unavailable.ts" },
    { ...scope, daemon: null }), false);
  assert.deepEqual(wrongDaemonOpens, []);
  assert.equal(await open({ path: "docs/invalid.md" }, { ...scope, daemonId: "not-a-daemon-id" }), false);
  assert.equal(invalidLocations, 1);
  assert.equal(navigated.length, 1);
});

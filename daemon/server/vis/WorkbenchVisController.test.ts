/* No production exports. Protect vis session snapshots, render-in-flight publication, coalesced re-renders, CSS failures keeping the last render, ending and resuming. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { ThreadVisCommand, ThreadVisResult, ThreadVisStoredSession } from "../database/vis/WorkbenchThreadVisStore";
import WorkbenchVisController from "./WorkbenchVisController";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("vis-controller-");
  context.after(() => temporary.dispose());
  const root = temporary.path;
  const sessions = new Map<string, ThreadVisStoredSession>();
  const snapshots = new Map<string, { document: string | null; failure: string | null }>();
  const store = async (command: ThreadVisCommand): Promise<ThreadVisResult> => {
    switch (command.kind) {
      case "start": sessions.set(command.session.sessionId, { ...command.session, endedAt: null });
        snapshots.set(`${command.session.sessionId}:start`, command.snapshot); break;
      case "end": for (const value of sessions.values()) if (value.threadId === command.threadId && value.path === command.path && value.endedAt === null) {
        value.endedAt = command.snapshot.capturedAt;
        snapshots.set(`${value.sessionId}:end`, command.snapshot);
      } break;
      case "readActive": return { sessions: [...sessions.values()].filter(({ endedAt }) => endedAt === null), snapshot: null };
      case "readUserEnded": return { sessions: [], snapshot: null, userEnded: [] };
      default: break;
    }
    return { sessions: [], snapshot: null };
  };
  const watchers = new Map<string, () => void>();
  // `next.stdout` is what the producer pipes into `wb vis render`; the fake shell delivers it like the real CLI would.
  const css = { gates: [] as Array<ReturnType<typeof gate>>, commands: [] as string[][], next: { exitCode: 0, stdout: ".a{}", stderr: "" } };
  const create = (): WorkbenchVisController => {
    const controller: WorkbenchVisController = new WorkbenchVisController({
      store,
      resolveRoot: async () => root,
      runCommand: () => async ({ command }) => {
        css.commands.push(command);
        const held = css.gates.shift();
        if (held) await held.promise;
        const runId = /--run '([^']+)'$/u.exec(command.at(-1) ?? "")?.[1];
        if (css.next.exitCode === 0 && runId) controller.acceptRender(runId, css.next.stdout);
        return { ...css.next, stdout: "" };
      },
      scratchDirectory: path.join(root, ".scratch"),
      watch: (file, onChange) => { watchers.set(file, onChange); return () => watchers.delete(file); },
      now: () => 100,
      log: () => undefined,
    });
    return controller;
  };
  const file = path.join(root, "mock.html");
  const start = (controller: WorkbenchVisController) => controller.startSession({
    threadId: "thread", harness: "codex", cwd: root, projectId: "project", rootPath: root, path: "mock.html",
  });
  return { root, file, create, start, snapshots, sessions, watchers, css };
}

/** Resolves on the first publication whose thread state passes `accept`; file reads are real I/O, so no tick count works. */
function until(controller: WorkbenchVisController, accept: (session: ReturnType<WorkbenchVisController["read"]>["sessions"][number]) => boolean) {
  return new Promise<ReturnType<WorkbenchVisController["read"]>["sessions"][number]>(resolve => {
    const handle = controller.observe("thread", () => {
      const session = handle.read().sessions[0];
      if (!session || !accept(session)) return;
      handle.release();
      resolve(session);
    });
  });
}

const CONFIG = JSON.stringify({ vis: { css: { command: ["css", "{file}", "{input}"], input: "@source \"{file}\";" } } });

test("a change keeps the last render while one is in flight, and a burst of changes renders once more", async context => {
  const f = await fixture(context);
  await writeFile(path.join(f.root, ".wb.json"), CONFIG);
  await writeFile(f.file, "<p>one</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  assert.equal(f.snapshots.get(`${sessionId}:start`)?.document, "<p>one</p>");

  await writeFile(f.file, `<head><link rel="workbench-css"></head><p>two</p>`);
  const held = gate();
  f.css.gates.push(held);
  const watched = [...f.watchers.values()][0]!;
  const inFlight = controller.observe("thread", () => undefined);
  watched();
  const marked = inFlight.read().sessions[0]!;
  assert.deepEqual([marked.rendering, marked.render?.document], [true, "<p>one</p>"], "the old render stays while the new one runs");
  inFlight.release();
  watched();
  watched();
  const done = until(controller, session => !session.rendering);
  held.open();
  const finished = await done;
  assert.equal(f.css.commands.length, 2, "three changes during one render cause exactly one follow-up");
  assert.equal(finished.render?.document, "<head><style>.a{}</style></head><p>two</p>");
  controller.dispose();
});

test("a failing CSS command keeps the previous render and reports why", async context => {
  const f = await fixture(context);
  await writeFile(path.join(f.root, ".wb.json"), CONFIG);
  await writeFile(f.file, `<link rel="workbench-css"><p>styled</p>`);
  const controller = f.create();
  await f.start(controller);
  // The command runs through the login shell with `{file}` substituted as one quoted argument.
  assert.ok(f.css.commands[0]?.at(-1)?.includes(`'${f.file.replaceAll("\\", "/")}'`));
  const first = controller.read("thread").sessions[0]!.render?.document;
  f.css.next = { exitCode: 1, stdout: "", stderr: "unknown utility" };
  const done = until(controller, current => !current.rendering);
  [...f.watchers.values()][0]!();
  const session = await done;
  assert.equal(session.render?.document, first);
  assert.match(session.failure ?? "", /^CSS: The CSS command exited with code 1\.\nunknown utility/u);
  controller.dispose();
});

test("a component re-renders when a file its build read changes, and watching follows the latest inputs", async context => {
  const f = await fixture(context);
  await writeFile(path.join(f.root, ".wb.json"), JSON.stringify({ vis: { build: { command: ["build", "{file}"] } } }));
  const entry = path.join(f.root, "mock.tsx");
  await writeFile(entry, "export default () => null;");
  const button = path.join(f.root, "Button.tsx");
  f.css.next = { exitCode: 0, stdout: JSON.stringify({ document: "<p>one</p>", inputs: ["mock.tsx", "Button.tsx", "node_modules/react/index.js"] }), stderr: "" };
  const controller = f.create();
  await controller.startSession({ threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "mock.tsx" });
  assert.deepEqual([...f.watchers.keys()].sort(), [button, entry].sort(), "dependencies are watched; node_modules is not");

  f.css.next = { exitCode: 0, stdout: JSON.stringify({ document: "<p>two</p>", inputs: ["mock.tsx"] }), stderr: "" };
  const done = until(controller, session => !session.rendering);
  f.watchers.get(button)!();
  assert.equal((await done).render?.document, "<p>two</p>");
  assert.deepEqual([...f.watchers.keys()], [entry], "inputs the build stopped reading are no longer watched");
  controller.dispose();
});

test("a user end is listed for the user only, and the session can't be ended twice", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>x</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  await controller.endById("thread", sessionId);
  assert.deepEqual(controller.read("thread"), { sessions: [], userEnded: [{ sessionId, path: "mock.html", endedAt: 100 }] });
  await assert.rejects(controller.endById("thread", sessionId), /no longer live/u);
  controller.dispose();
});

test("ending snapshots the current file and stops watching; a new generation resumes live sessions", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>start</p>");
  const first = f.create();
  const { sessionId } = await f.start(first);
  await assert.rejects(f.start(first), /already live/u);
  first.dispose();

  const second = f.create();
  await second.start();
  assert.equal(second.read("thread").sessions[0]?.sessionId, sessionId, "the stored live session resumes");
  await writeFile(f.file, "<p>end</p>");
  await second.endSession({ threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" });
  assert.equal(f.snapshots.get(`${sessionId}:end`)?.document, "<p>end</p>");
  assert.deepEqual(second.read("thread").sessions, []);
  assert.equal(f.watchers.size, 0);
  await assert.rejects(second.endSession({ threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" }), /No vis session is live/u);
  await assert.rejects(f.create().startSession({
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "../outside.html",
  }), /ENOENT|inside the caller's project/u);
  assert.equal(await readFile(f.file, "utf8"), "<p>end</p>");
  second.dispose();
});

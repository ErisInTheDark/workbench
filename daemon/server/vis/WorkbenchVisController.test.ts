/* No production exports. Protect vis session snapshots, render-in-flight publication, coalesced re-renders, CSS failures keeping the last render, build contexts, synced control state, browser checks, ending and resuming. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import type { VisControls } from "workbench-shared/workbench/vis/vis-contract";
import type { ThreadVisCommand, ThreadVisResult, ThreadVisStoredSession } from "../database/vis/WorkbenchThreadVisStore";
import WorkbenchVisController from "./WorkbenchVisController";
import WorkbenchComponentsController from "../skills/WorkbenchComponentsController";
import { compileSkillStyles, compileSkillTemplate, renderSkillComponent, renderSkillComponentPreview } from "../../../scripts/skill-component-build.mts";

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
  const controls = new Map<string, VisControls>();
  const store = async (command: ThreadVisCommand): Promise<ThreadVisResult> => {
    switch (command.kind) {
      case "start": sessions.set(command.session.sessionId, { ...command.session, endedAt: null });
        snapshots.set(`${command.session.sessionId}:start`, command.snapshot); break;
      case "end": for (const value of sessions.values()) if (value.threadId === command.threadId && value.path === command.path && value.endedAt === null) {
        value.endedAt = command.snapshot.capturedAt;
        snapshots.set(`${value.sessionId}:end`, command.snapshot);
      } break;
      case "readActive": return { sessions: [...sessions.values()].filter(({ endedAt }) => endedAt === null), snapshot: null };
      case "setControl": {
        const live = sessions.get(command.sessionId);
        if (!live || live.endedAt !== null || live.threadId !== command.threadId) break;
        const key = `${live.threadId}:${live.path}`;
        controls.set(key, { ...controls.get(key), [command.controlId]: command.value });
        return { sessions: [live], snapshot: null };
      }
      case "readControls": return { sessions: [], snapshot: null, controls: controls.get(`${command.threadId}:${command.path}`) ?? {} };
      case "readSnapshot": {
        const stored = sessions.get(command.sessionId);
        const captured = snapshots.get(`${command.sessionId}:${command.snapshotKind}`);
        if (!stored || !captured) break;
        return {
          sessions: [stored],
          snapshot: { sessionId: stored.sessionId, kind: command.snapshotKind, path: stored.path, capturedAt: 100, ...captured },
        };
      }
      default: break;
    }
    return { sessions: [], snapshot: null };
  };
  const watchers = new Map<string, () => void>();
  // `next.stdout` is what the producer pipes into `wb vis render`; the fake shell delivers it like the real CLI would.
  const css = {
    gates: [] as Array<ReturnType<typeof gate>>, commands: [] as string[][], cwds: [] as string[],
    next: { exitCode: 0, stdout: ".a{}", stderr: "" },
  };
  const workbenchRoot = path.join(root, "workbench-checkout");
  let current: WorkbenchVisController | null = null;
  /** The browser loads the served page, so the fake records what serving would have shown it. */
  const shown = async (sessionId: string) => {
    const served = await current!.serve(sessionId, "live");
    browse.controls.push(served?.controls ?? {});
    return served?.document ?? "(nothing)";
  };
  /** The controller fires opens and refreshes without waiting; tests settle them before reading `calls`. */
  const settle = (work: Promise<void>) => { browse.pending.push(work); return work; };
  const browse = {
    calls: [] as string[],
    controls: [] as VisControls[],
    pending: [] as Promise<void>[],
    failure: null as Error | null,
    stopFailure: null as Error | null,
    open: (target: { sessionId: string }) => settle(shown(target.sessionId).then(document => { browse.calls.push(`open ${document}`); })),
    inspect: async (target: { sessionId: string }, kind: "snapshot" | "screenshot") => {
      const document = await shown(target.sessionId);
      browse.calls.push(`${kind} ${document}`);
      if (browse.failure) throw browse.failure;
      return `${kind} of ${document}`;
    },
    inspectDocument: async (target: { document: string }) => {
      browse.calls.push(`screenshot ${target.document}`);
      if (browse.failure) throw browse.failure;
      return `screenshot of ${target.document}`;
    },
    refresh: (target: { sessionId: string }) => settle(shown(target.sessionId).then(document => { browse.calls.push(`refresh ${document}`); })),
    end: async (target: { sessionId: string }) => {
      browse.calls.push(`end ${target.sessionId}`);
      if (browse.stopFailure) throw browse.stopFailure;
    },
  };
  const create = (componentPreview?: (threadId: string, markup: string, signal: AbortSignal) => Promise<string>): WorkbenchVisController => {
    const controller: WorkbenchVisController = new WorkbenchVisController({
      store,
      ...(componentPreview ? { componentPreview } : {}),
      resolveRoot: async () => root,
      runCommand: () => async ({ command, cwd }) => {
        css.commands.push(command);
        css.cwds.push(cwd);
        const held = css.gates.shift();
        if (held) await held.promise;
        const runId = /--run '([^']+)'$/u.exec(command.at(-1) ?? "")?.[1];
        if (css.next.exitCode === 0 && runId) controller.acceptRender(runId, css.next.stdout);
        return { ...css.next, stdout: "" };
      },
      scratchDirectory: path.join(root, ".scratch"),
      workbenchRoot,
      browse,
      watch: (file, onChange) => { watchers.set(file, onChange); return () => watchers.delete(file); },
      now: () => 100,
      log: () => undefined,
    });
    current = controller;
    return controller;
  };
  const file = path.join(root, "mock.html");
  const start = (controller: WorkbenchVisController) => controller.startSession({
    threadId: "thread", harness: "codex", cwd: root, projectId: "project", rootPath: root, path: "mock.html", project: { kind: "caller" },
  });
  return { root, file, create, start, snapshots, sessions, watchers, css, workbenchRoot, browse };
}

async function served(controller: WorkbenchVisController, sessionId: string) {
  return (await controller.serve(sessionId, "live"))?.document;
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

test("markup tests screenshot the rendered component and always close their temporary browser", async context => {
  const f = await fixture(context);
  const controller = f.create(async (_threadId, markup) => `<p>${markup}</p>`);
  const input = { threadId: "thread", cwd: f.root, markup: "<Card />" };
  assert.equal(await controller.testMarkup(input), "screenshot of <p><Card /></p>");
  assert.equal(f.sessions.size, 0);
  assert.match(f.browse.calls.at(-1)!, /^end /u);
  f.browse.failure = new Error("screenshot failed");
  await assert.rejects(controller.testMarkup(input), /screenshot failed/u);
  assert.match(f.browse.calls.at(-1)!, /^end /u);
});

test("markup tests retain screenshot and cleanup failures together", async context => {
  const f = await fixture(context);
  const controller = f.create(async () => "<p>component</p>");
  f.browse.failure = new Error("screenshot failed");
  f.browse.stopFailure = new Error("cleanup failed");
  await assert.rejects(
    controller.testMarkup({ threadId: "thread", cwd: f.root, markup: "<Card />" }),
    error => error instanceof AggregateError && error.errors.some(item => item.message === "screenshot failed")
      && error.errors.some(item => item.message === "cleanup failed"),
  );
});

test("vis markup test renders the active skill's real template and kit nodes", async context => {
  const f = await fixture(context);
  const folder = path.join(f.root, "skill");
  await mkdir(folder);
  const skillPath = path.join(folder, "SKILL.md");
  const content = "---\nname: cards\nworkbench_components:\n  - Card.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(path.join(folder, "Card.tsx"), `import { Options, Option } from "workbench/kit";
    export default function Card({ labels, content }: { labels: number[], content: string }) {
      return <div><span>{labels.join(",")}</span><Options label="pick"><Option title="one">{content}</Option></Options></div>
    }`);
  const components = new WorkbenchComponentsController({
    skills: async () => [{ path: skillPath, relativePath: "skill/SKILL.md", name: "cards", description: "", content }],
    compile: async (file, _threadId, _signal, root) => await compileSkillTemplate(file, root),
    compileStyles: async (files, _threadId, root) => await compileSkillStyles(files, root),
    evaluate: async (compiled, name, markup) => await renderSkillComponent(compiled, name, markup),
    preview: async result => await renderSkillComponentPreview(result),
    read: async () => null,
    write: async (_target, tree) => tree,
  });
  const controller = f.create((threadId, markup, signal) => components.previewMarkup(threadId, markup, signal));
  const output = await controller.testMarkup({
    threadId: "thread", cwd: f.root, markup: '<Card labels={[1, 3, 4]} content="cool card" />',
  });
  assert.equal(output.includes("1,3,4"), true);
  assert.equal(output.includes("cool card"), true);
  assert.match(f.browse.calls.at(-1)!, /^end /u);
  await assert.rejects(controller.testMarkup({ threadId: "thread", cwd: f.root, markup: "<Missing />" }), /active/i);
});

test("vis markup renders nested skill components and markdown as children", async context => {
  const f = await fixture(context);
  const folder = path.join(f.root, "skill");
  await mkdir(folder);
  const skillPath = path.join(folder, "SKILL.md");
  const content = "---\nname: cards\nworkbench_components:\n  - FirstComponent.tsx\n  - SecondComponent.tsx\n---\n";
  await writeFile(skillPath, content);
  await writeFile(path.join(folder, "FirstComponent.tsx"), "export default function First({ children }) { return <section>{children}</section>; }");
  await writeFile(path.join(folder, "SecondComponent.tsx"), "export default function Second() { return <div>nested card</div>; }");
  let active = true;
  const saved = new Map<string, import("workbench-shared/workbench/thread/thread-component-tree").ThreadComponentNode>();
  const components = new WorkbenchComponentsController({
    skills: async () => active ? [{ path: skillPath, relativePath: "skill/SKILL.md", name: "cards", description: "", content }] : [],
    compile: async (file, _threadId, _signal, root) => await compileSkillTemplate(file, root),
    compileStyles: async (files, _threadId, root) => await compileSkillStyles(files, root),
    evaluate: async (compiled, name, markup) => await renderSkillComponent(compiled, name, markup),
    preview: async result => await renderSkillComponentPreview(result),
    read: async target => saved.get(target.markup) ?? null,
    write: async (target, tree) => { saved.set(target.markup, tree); return tree; },
  });
  const controller = f.create((threadId, markup, signal) => components.previewMarkup(threadId, markup, signal));
  const output = await controller.testMarkup({
    threadId: "thread", cwd: f.root,
    markup: "<FirstComponent>\n<SecondComponent />\n\n**markdown**\n</FirstComponent>",
  });
  assert.equal(output.includes("nested card"), true);
  assert.equal(output.includes("<strong>markdown</strong>"), true);
  const notice = await controller.testMarkup({
    threadId: "thread", cwd: f.root,
    markup: '<FirstComponent>\n<notice title="inside" color="blue">\n<SecondComponent />\n</notice>\n\n```tsx\n<Missing />\n```\n</FirstComponent>',
  });
  assert.equal(notice.includes("nested card"), true);
  assert.equal(notice.includes("data-thread-notice"), true);
  await assert.rejects(controller.testMarkup({
    threadId: "thread", cwd: f.root, markup: "<FirstComponent>\n<Missing />\n</FirstComponent>",
  }), /No active skill exposes component Missing/u);
  const markup = "<FirstComponent>\n<SecondComponent />\n\n**markdown**\n</FirstComponent>";
  const target = { threadId: "thread", itemId: "message", markup };
  const shown = await components.renderMessage(target);
  active = false;
  assert.deepEqual((await components.renderMessage(target)).tree, shown.tree);
  const retained = await renderSkillComponentPreview({ tree: shown.tree, css: "" });
  assert.equal(retained.includes("nested card"), true);
  assert.equal(retained.includes("<strong>markdown</strong>"), true);
});

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
  assert.deepEqual([marked.rendering, await served(controller, sessionId)], [true, "<p>one</p>"], "the old render stays while the new one runs");
  inFlight.release();
  watched();
  watched();
  const done = until(controller, session => !session.rendering);
  held.open();
  const finished = await done;
  assert.equal(f.css.commands.length, 2, "three changes during one render cause exactly one follow-up");
  const document = "<head><style>.a{}</style></head><p>two</p>";
  assert.equal(await served(controller, sessionId), document);
  assert.equal(finished.render?.bytes, Buffer.byteLength(document), "observers learn the size, never the document");
  controller.dispose();
});

test("a failing CSS command keeps the previous render and reports why", async context => {
  const f = await fixture(context);
  await writeFile(path.join(f.root, ".wb.json"), CONFIG);
  await writeFile(f.file, `<link rel="workbench-css"><p>styled</p>`);
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  // The command runs through the login shell with `{file}` substituted as one quoted argument.
  assert.ok(f.css.commands[0]?.at(-1)?.includes(`'${f.file.replaceAll("\\", "/")}'`));
  const first = await served(controller, sessionId);
  f.css.next = { exitCode: 1, stdout: "", stderr: "unknown utility" };
  const done = until(controller, current => !current.rendering);
  [...f.watchers.values()][0]!();
  const session = await done;
  assert.equal(await served(controller, sessionId), first);
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
  const { sessionId } = await controller.startSession({
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "mock.tsx", project: { kind: "caller" },
  });
  assert.deepEqual([...f.watchers.keys()].sort(), [button, entry].sort(), "dependencies are watched; node_modules is not");

  f.css.next = { exitCode: 0, stdout: JSON.stringify({ document: "<p>two</p>", inputs: ["mock.tsx"] }), stderr: "" };
  const done = until(controller, session => !session.rendering);
  f.watchers.get(button)!();
  await done;
  assert.equal(await served(controller, sessionId), "<p>two</p>");
  assert.deepEqual([...f.watchers.keys()], [entry], "inputs the build stopped reading are no longer watched");
  controller.dispose();
});

test("a user end names the ended session for its transcript item, and the session can't be ended twice", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>x</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  assert.deepEqual(await controller.endById("thread", sessionId), { sessionId, path: "mock.html", failure: null });
  assert.deepEqual(controller.read("thread"), { sessions: [] });
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
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "../outside.html", project: { kind: "caller" },
  }), /ENOENT|inside the caller's project/u);
  assert.equal(await readFile(f.file, "utf8"), "<p>end</p>");
  second.dispose();
});

test("a session serves its live render only while live, and its start and end snapshots from the same build root", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>start</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  assert.deepEqual(await controller.serve(sessionId, "live"), { document: "<p>start</p>", rootPath: f.root, controls: {} });
  await writeFile(f.file, "<p>end</p>");
  await controller.endSession({ threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" });
  assert.equal(await controller.serve(sessionId, "live"), null, "an ended session has no live page");
  assert.deepEqual(await controller.serve(sessionId, "start"), { document: "<p>start</p>", rootPath: f.root, controls: {} });
  assert.equal((await controller.serve(sessionId, "end"))?.document, "<p>end</p>");
  assert.deepEqual(await controller.readSnapshot(sessionId, "end"), {
    sessionId, kind: "end", path: "mock.html", capturedAt: 100, bytes: Buffer.byteLength("<p>end</p>"), failure: null,
  });
  controller.dispose();
});

test("a session's browser opens with it, follows each rebuild, checks its latest render, and stops when it ends", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>one</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  const target = { threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" };
  await writeFile(f.file, "<p>two</p>");
  f.watchers.get(f.file)!();
  await until(controller, session => !session.rendering);
  await Promise.all(f.browse.pending);
  assert.equal(await controller.inspect(target, "screenshot"), "screenshot of <p>two</p>");
  await controller.endSession(target);
  assert.deepEqual(f.browse.calls, ["open <p>one</p>", "refresh <p>two</p>", "screenshot <p>two</p>", `end ${sessionId}`]);
  await assert.rejects(controller.inspect(target, "snapshot"), /No vis session is live/u);
  controller.dispose();
});

test("a session builds in its chosen context, and a resumed session keeps it", async context => {
  const f = await fixture(context);
  const entry = path.join(f.root, "mock.tsx");
  await writeFile(entry, "export default () => null;");
  // No `.wb.json` in the caller's project: the kit context needs none.
  f.css.next = { exitCode: 0, stdout: JSON.stringify({ document: "<p>kit</p>", inputs: ["../mock.tsx", "../../kit-outside-the-project/index.ts"] }), stderr: "" };
  const first = f.create();
  await first.startSession({
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "mock.tsx", project: { kind: "kit" },
  });
  assert.equal(f.css.cwds[0], f.workbenchRoot, "the kit context runs in Workbench's checkout");
  assert.ok(f.css.commands[0]?.at(-1)?.includes("'--kit'"), "and builds with the kit");
  assert.deepEqual([...f.watchers.keys()], [entry], "the caller's file is watched; Workbench's kit is not");
  first.dispose();

  const resumed = f.create();
  await resumed.start();
  await until(resumed, session => session.render !== null);
  assert.equal(f.css.cwds.at(-1), f.workbenchRoot, "a resumed session still builds in the kit context");
  resumed.dispose();

  const folder = path.join(f.root, "other");
  await assert.rejects(resumed.startSession({
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "mock.tsx", project: { kind: "folder", path: "other" },
  }), /not a folder/u);
  await mkdir(folder);
  await assert.rejects(f.create().startSession({
    threadId: "thread", harness: "codex", cwd: f.root, projectId: "project", rootPath: f.root, path: "mock.tsx", project: { kind: "folder", path: "other" },
  }), /no \.wb\.json/u);
});

test("control changes are JSON from a live session, reach every frame of it, and read back for its file", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>x</p>");
  const controller = f.create();
  const { sessionId } = await f.start(controller);
  const target = { threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" };
  await assert.rejects(controller.setControl("thread", sessionId, "tab", "not json"), /must be JSON/u);
  const published = until(controller, session => session.controls.tab === "\"card\"");
  await controller.setControl("thread", sessionId, "tab", "\"card\"");
  await published;
  await Promise.all(f.browse.pending);
  assert.deepEqual([f.browse.calls.at(-1), f.browse.controls.at(-1)], ["refresh <p>x</p>", { tab: "\"card\"" }], "a reload in the agent's browser sees the user's state");
  assert.deepEqual(await controller.readControls(target), { path: "mock.html", live: true, controls: { tab: "\"card\"" } });
  await controller.inspect(target, "screenshot");
  assert.deepEqual(f.browse.controls.at(-1), { tab: "\"card\"" }, "the agent's browser sees the user's state");
  await assert.rejects(controller.setControl("thread", "00000000-0000-4000-8000-000000000000", "tab", "1"), /no longer live/u);
  controller.dispose();
});

test("a restarted session, or a resumed one, starts from the file's stored control state", async context => {
  const f = await fixture(context);
  await writeFile(f.file, "<p>x</p>");
  const first = f.create();
  const { sessionId } = await f.start(first);
  await first.setControl("thread", sessionId, "tab", "\"step\"");
  await first.endSession({ threadId: "thread", cwd: f.root, rootPath: f.root, path: "mock.html" });
  await f.start(first);
  assert.deepEqual(first.read("thread").sessions[0]?.controls, { tab: "\"step\"" });
  first.dispose();

  const resumed = f.create();
  await resumed.start();
  assert.deepEqual(resumed.read("thread").sessions[0]?.controls, { tab: "\"step\"" });
  resumed.dispose();
});

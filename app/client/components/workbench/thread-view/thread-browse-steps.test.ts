/*
 * No production exports. Regression wards protect how one Browse call's steps merge progress, recorded results and screenshots.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";

import { getThreadCommandDisplay, getWorkbenchMcpCommandDisplay } from "../../../workbench/thread/thread-command-matchers";
import {
  describeBrowseStep, getBrowseItemSteps, getBrowseScreenshotUrls, getBrowseSteps, getCurrentBrowseStep, getLiftedBrowseSteps,
} from "./thread-browse-steps";
import type { CommandItem } from "./thread-render-blocks";

const RUN = 'wb browse run --session lab --command "open http://localhost:3002" --command "click text=Save" --command screenshot';

function browse(output: string, status: CommandItem["status"] = "completed"): CommandItem {
  return { id: "browse", type: "commandExecution", command: RUN, commandActions: [], cwd: "C:/repo", durationMs: 1,
    exitCode: status === "inProgress" ? null : 0, aggregatedOutput: output, pluginId: null, processId: null,
    scriptPath: null, source: "agent", status };
}

const event = (value: object) => JSON.stringify(value);

function steps(item: CommandItem, entries: WorkbenchBrowseResultEntry[] = []) {
  return getBrowseItemSteps(item, getThreadCommandDisplay({ command: item.command, commandActions: [], cwd: item.cwd }), entries) ?? [];
}

test("a live CLI call reports the step it is on from streamed progress", () => {
  const live = browse([
    event({ type: "browse-sequence-start", totalActions: 3 }),
    event({ type: "browse-action-complete", index: 0, result: { ok: true, durationMs: 40 } }),
    event({ type: "browse-action-start", index: 1 }),
  ].join("\n"), "inProgress");
  const rows = steps(live);
  assert.deepEqual(rows.map(row => row.state), ["completed", "inProgress", "queued"]);
  assert.equal(describeBrowseStep(getCurrentBrowseStep(rows)!), "Click text=Save");
});

test("without streamed progress, a live call is on the first step without a recorded result", () => {
  const recorded = (actionIndex: number): WorkbenchBrowseResultEntry => ({
    action: "open", actionIndex, assetUrl: null, commandItemId: "browse", durationMs: 5, entryKey: `e${actionIndex}`,
    recordedAt: actionIndex, session: "lab", state: "completed", threadId: "thread", turnId: "turn",
  });
  assert.deepEqual(steps(browse("", "inProgress"), [recorded(0), recorded(1)]).map(row => row.state), ["completed", "completed", "inProgress"]);
});

test("a screenshot receipt becomes the step's image instead of its text", () => {
  const receipt = JSON.stringify({ screenshot: "captured", assetUrl: "/asset/shot.png", injected: true });
  const done = browse(event({ type: "browse-sequence-complete", results: [
    { ok: true }, { ok: true }, { ok: true, stdout: receipt },
  ] }));
  const [, , shot] = steps(done);
  assert.equal(shot?.imageUrl, "/asset/shot.png");
  assert.equal(shot?.detailText, null);
  assert.equal(shot?.defaultOpen, true);
  assert.deepEqual([...getBrowseScreenshotUrls([done], [])], ["/asset/shot.png"]);
});

test("recorded results fill steps by action index, and alone still describe the call in order", () => {
  const entry = (actionIndex: number, action: string, assetUrl: string | null = null): WorkbenchBrowseResultEntry => ({
    action, actionIndex, assetUrl, commandItemId: "browse", detailText: null, durationMs: 5, entryKey: `e${actionIndex}`,
    recordedAt: actionIndex, session: "lab", state: "completed", threadId: "thread", turnId: "turn",
  });
  const recorded = [entry(2, "screenshot", "/asset/recorded.png"), entry(0, "open", "/asset/auto.png")];
  const [open, , shot] = steps(browse(""), recorded);
  assert.equal(shot?.imageUrl, "/asset/recorded.png");
  assert.equal(shot?.defaultOpen, true, "an explicit screenshot shows open");
  assert.equal(open?.defaultOpen, undefined, "an automatic navigation capture stays one click away");
  assert.deepEqual(getBrowseSteps({ entries: recorded, outcome: "completed", output: null, rows: [] }).map(row => row.label), ["Open", "Screenshot"]);
  assert.deepEqual([...getBrowseScreenshotUrls([], recorded)], ["/asset/recorded.png", "/asset/auto.png"]);
});

test("recorded steps take the same action and name as the BrowseMD steps they ran", () => {
  const recorded = (actionIndex: number, action: string): WorkbenchBrowseResultEntry => ({
    action, actionIndex, assetUrl: null, commandItemId: "browse", detailText: null, durationMs: 5, entryKey: `e${actionIndex}`,
    recordedAt: actionIndex, session: "lab", state: "completed", threadId: "thread", turnId: "turn",
  });
  const rows = getBrowseSteps({ entries: [recorded(0, "initScript"), recorded(1, "eval"), recorded(2, "mouseClick")], outcome: "completed", output: null, rows: [] });
  assert.deepEqual(rows.map(row => [row.action, row.label]), [["init-js", "Install page script"], ["eval", "Evaluate"], ["mouse", "Mouse click"]]);
});

test("fenced page scripts read as an evaluate step naming the script's first line", () => {
  const display = getWorkbenchMcpCommandDisplay({
    argumentsValue: { commands: ["```js\nreturn document.title;\nconsole.log(1);\n```"], session: "lab" },
    context: {}, server: "wb", tool: "browse_run",
  });
  const [step] = getBrowseSteps({ outcome: "inProgress", output: null, rows: display?.detailRows });
  assert.equal(describeBrowseStep(step!), "Evaluate return document.title;");
});

test("lifted steps keep data answers, drop acknowledgements, and a failure no step explains keeps its call row", () => {
  const display = getThreadCommandDisplay({ command: RUN, commandActions: [], cwd: "C:/repo" });
  const done = browse(event({ type: "browse-sequence-complete", results: [
    { ok: true, stdout: "{\"mode\":\"managed-local\"}" }, { ok: true }, { ok: true },
  ] }));
  assert.equal(getLiftedBrowseSteps(done, display, [])?.[0]?.detailText, null, "open's session acknowledgement is noise");

  const unexplained = { ...browse(""), exitCode: 1, status: "failed" as const };
  assert.equal(getLiftedBrowseSteps(unexplained, display, []), null);
  const explained = browse(event({ type: "browse-sequence-complete", results: [{ ok: true }, { ok: false, error: "no match" }] }), "failed");
  const lifted = getLiftedBrowseSteps({ ...explained, exitCode: 1 }, display, []);
  assert.equal(lifted?.[1]?.detailText, "no match");
  assert.deepEqual(lifted?.map(step => step.state), ["completed", "failed", "queued"], "steps after the failure never ran");
});

test("non-Browse commands have no steps", () => {
  const plain = { ...browse(""), command: "pwd" };
  assert.equal(getBrowseItemSteps(plain, getThreadCommandDisplay({ command: "pwd", commandActions: [], cwd: "C:/repo" }), []), null);
});

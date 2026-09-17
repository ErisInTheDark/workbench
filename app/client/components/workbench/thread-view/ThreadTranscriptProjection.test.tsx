/*
 * No production exports. Tests protect canonical SQLite order, grouping, hidden controls, turn ownership, and Browse attachment.
 */
import assert from "node:assert/strict";
import { createRef } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { mergeThreadItem, normalizeThreadItems } from "workbench-shared/workbench/thread/thread-item-normalization";
import { createWorkbenchAgentMessageOutput } from "workbench-shared/workbench/thread/thread-agent-message";
import { createWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { getWorkbenchTranscriptAssetUrl } from "workbench-shared/workbench/workbench-connection";
import type { WorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import type { ThreadReasoningStepReference } from "./thread-reasoning-display";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";

function turn(id: string, turnIndex: number, items: ThreadItem[]): WorkbenchProjectedTranscriptTurn {
  return {
    completedAt: 3,
    durationMs: 2_000,
    error: null,
    id,
    items,
    itemsView: "full",
    itemTimeline: [],
    startedAt: 1,
    status: "completed",
    turnIndex,
  };
}

function command(id: string, value: string): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    aggregatedOutput: "",
    command: value,
    commandActions: [],
    cwd: "C:/project",
    durationMs: 10,
    exitCode: 0,
    id,
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
}

function renderItems(
  items: ThreadItem[],
  hiddenReasoningStep: ThreadReasoningStepReference | null = null,
  durableItemCount = items.length,
  hoistedGitArcProposalIds: ReadonlySet<string> = new Set(),
) {
  const turns = [turn("turn", 0, items)];
  const projection: WorkbenchTranscriptProjection = {
    browseResultEntries: [],
    display: planCanonicalTranscriptDisplay({
      items: items.slice(0, durableItemCount).map((payload, itemIndex) => ({
        itemId: payload.id,
        itemIndex,
        payload,
        turnId: "turn",
      })),
      turns: [{ turnId: "turn", turnIndex: 0 }],
      virtualTail: items.slice(durableItemCount).map((payload) => ({
        payload,
        turnId: "turn",
      })),
    }),
    hasPreviousTurns: false,
    thread: {
      activityAt: 3_000,
      createdAt: 1_000,
      id: "thread",
      projectId: "project",
      projectRoot: "C:/project",
      title: "Thread",
      updatedAt: 3_000,
    },
    turnHistory: [],
    turns,
  };
  return renderToStaticMarkup(
    <ThreadTranscriptProjection
      canLoadPreviousTurn={false}
      hiddenReasoningStep={hiddenReasoningStep}
      historySentinelRef={createRef<HTMLDivElement>()}
      hoistedGitArcProposalIds={hoistedGitArcProposalIds}
      knownSkills={[]}
      projectFilePaths={[]}
      projectId="project"
      projectRootPath="C:/project"
      presentationSource={{ kind: "sqlite", sourceKey: "codex:thread" }}
      projection={projection}
      relatedThreadsById={{}}
      subagents={[]}
      workspaceRoots={[]}
    />,
  );
}

test("standalone skill transport adds no display while visible and missing user content survive", () => {
  const activated = createWorkbenchActivatedSkillsInput('<skill filename="example">Follow the workflow.</skill>');
  const message = (id: string, content: Extract<ThreadItem, { type: "userMessage" }>["content"]): ThreadItem => ({
    clientId: null, content, id, type: "userMessage",
  });
  const visibleParts: Extract<ThreadItem, { type: "userMessage" }>["content"][] = [
    [{ type: "text", text: "approved, keep going", text_elements: [] }],
    [{ type: "image", url: "/attachment.png" }],
    [{ type: "text", text: `${activated.text} is quoted user content`, text_elements: [] }],
  ];
  for (const durable of [false, true]) {
    const render = (items: ThreadItem[]) => renderItems(items, null, durable ? items.length : 0);
    for (const parts of visibleParts) {
      const visible = message("visible", parts);
      assert.equal(
        render([visible, message("skills", [activated, activated])]),
        render([visible]),
        "standalone hidden transport must not add a bubble",
      );
      assert.equal(
        render([message("visible", [...parts, activated])]),
        render([visible]),
        "mixed input must preserve visible content",
      );
    }
    const empty = message("empty", []);
    const visible = message("visible", visibleParts[0]);
    assert.notEqual(render([visible, empty]), render([visible]), "missing content is not hidden transport");
  }
});

test("canonical projection removes a proposal source while its card is hoisted", () => {
  const proposal = {
    ...command("proposal", 'wb git arc propose --title "Move this proposal" -- src/one.ts'),
    aggregatedOutput: "Workbench arc proposal: proposal-one\n",
  };
  const html = renderItems([proposal], null, 1, new Set(["proposal-one"]));
  assert.doesNotMatch(html, /data-thread-checkpoint-proposal-source=/u);
  assert.doesNotMatch(html, /data-thread-checkpoint-card=/u);
});

test("native incoming messages and screenshots render once per identity after provider echo reconciliation", () => {
  const assetUrl = "/api/transcript-assets/codex/thread/screenshot.png";
  const message = { message: "check cancellation cleanup", senderName: "iris", senderThreadId: "child" };
  const incoming: ThreadItem = { ...createWorkbenchAgentMessageOutput(message), id: "incoming", type: "functionCallOutput" };
  const screenshot: WorkbenchToolOutput = {
    id: "screenshot", type: "functionCallOutput", name: "screenshot", namespace: "workbench",
    output: [{ type: "input_text", text: "capture context" }, { type: "input_image", image_url: assetUrl, detail: "auto" }],
    workbenchInjectionAcceptedAt: 10,
  };
  const { workbenchInjectionAcceptedAt: _acceptedAt, ...echo } = screenshot;
  const recovery: ThreadItem = {
    id: "recovery", type: "functionCallOutput", name: "patch_recovery", namespace: "workbench", output: "patch recovery details",
  };
  const items = normalizeThreadItems([incoming, screenshot, incoming, echo, recovery], {
    mergeDuplicateItems: (stored, next) => mergeThreadItem(next, stored),
  });
  for (const durableCount of [0, items.length]) {
    const html = renderItems(items, null, durableCount);
    assert.equal(html.split(message.message).length - 1, 1);
    const sources = [...html.matchAll(/<img\b[^>]*src="([^"]+)"/gu)].map(match => match[1]);
    assert.deepEqual(sources, [getWorkbenchTranscriptAssetUrl(assetUrl)]);
    assert.equal(html.includes(recovery.output as string), false);
  }
});

test("SQLite projection preserves canonical order with initially closed Browse details", () => {
  const first: ThreadItem = {
    id: "first",
    memoryCitation: null,
    delivery: null,
    questions: null,
    phase: "commentary",
    text: "First SQLite item",
    type: "agentMessage",
  };
  const browse: Extract<ThreadItem, { type: "commandExecution" }> = {
    aggregatedOutput: "",
    command: 'wb browse run --thread thread --session rendering --summary "Check page" --command "snapshot --compact"',
    commandActions: [],
    cwd: "C:/project",
    durationMs: 10,
    exitCode: 0,
    id: "browse",
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
  const last: ThreadItem = {
    id: "last",
    memoryCitation: null,
    phase: "final_answer",
    delivery: null,
    questions: null,
    text: "Last SQLite item",
    type: "agentMessage",
  };
  const turns = [
    turn("turn-one", 0, [first, last]),
    turn("turn-two", 1, [browse]),
  ];
  const browseResultEntries: WorkbenchBrowseResultEntry[] = [{
    action: "snapshot",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: browse.id,
    detailKind: "result",
    detailLabel: "SQLite Browse detail",
    detailText: "Attached to turn two",
    durationMs: 10,
    entryKey: "browse:0",
    recordedAt: 2_000,
    session: "rendering",
    state: "completed",
    threadId: "thread",
    turnId: "turn-two",
  }];
  const projection: WorkbenchTranscriptProjection = {
    browseResultEntries,
    display: planCanonicalTranscriptDisplay<WorkbenchProjectedTranscriptItem>({
      items: [
        { itemId: first.id, itemIndex: 0, payload: first, turnId: "turn-one" },
        { itemId: last.id, itemIndex: 1, payload: last, turnId: "turn-one" },
        { itemId: browse.id, itemIndex: 2, payload: browse, turnId: "turn-two" },
      ],
      turns: turns.map(({ id, turnIndex }) => ({ turnId: id, turnIndex })),
    }),
    hasPreviousTurns: false,
    thread: {
      activityAt: 3_000,
      createdAt: 1_000,
      id: "thread",
      projectId: "project",
      projectRoot: "C:/project",
      title: "Thread",
      updatedAt: 3_000,
    },
    turnHistory: [],
    turns,
  };

  const html = renderToStaticMarkup(
    <ThreadTranscriptProjection
      canLoadPreviousTurn={false}
      historySentinelRef={createRef<HTMLDivElement>()}
      knownSkills={[]}
      projectFilePaths={[]}
      projectId="project"
      projectRootPath="C:/project"
      presentationSource={{ kind: "sqlite", sourceKey: "codex:thread" }}
      projection={projection}
      relatedThreadsById={{}}
      subagents={[]}
      workspaceRoots={[]}
    />,
  );

  const firstIndex = html.indexOf("First SQLite item");
  const lastIndex = html.indexOf("Last SQLite item");
  const browseIndex = html.indexOf("Check page");
  assert.notEqual(firstIndex, -1);
  assert.notEqual(browseIndex, -1);
  assert.notEqual(lastIndex, -1);
  assert.equal(firstIndex < lastIndex && lastIndex < browseIndex, true);
  assert.equal((html.match(/data-thread-history-turn-id="turn-one"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-thread-history-turn-id="turn-two"/gu) ?? []).length, 1);
});

test("SQLite normal projection keeps commands closed and opens latest reasoning", () => {
  const commandHtml = renderItems([
    command("one", "alpha --one"),
    command("two", "beta --two"),
  ], null, 1);
  const commandText = commandHtml.replace(/<[^>]+>/gu, "");
  assert.match(commandText, /Ran 2 commands/u);
  assert.doesNotMatch(commandHtml, /<details[^>]*\bopen=/u);

  const detailedHtml = renderItems([{
    content: [],
    id: "reasoning",
    summary: ["Careful title\nUseful description."],
    type: "reasoning",
  }]);
  assert.equal((detailedHtml.match(/Careful title/gu) ?? []).length, 1);
  assert.match(detailedHtml, /<details[^>]*\bopen=/u);
  assert.match(detailedHtml, /<details/u);

  const staticHtml = renderItems([{
    content: [],
    id: "reasoning",
    summary: ["Static title"],
    type: "reasoning",
  }]);
  assert.match(staticHtml, /Reasoned:\s*<\/span><span[^>]*>Static title/u);
  assert.doesNotMatch(staticHtml, /<details/u);
});

test("SQLite normal projection removes only the newest live reasoning section", () => {
  const html = renderItems([{
    content: [],
    id: "reasoning",
    summary: ["Earlier title\nEarlier detail.", "Latest title\nLatest detail."],
    type: "reasoning",
  }], {
    itemId: "reasoning",
    sectionIndex: 1,
    source: "summary",
  });

  assert.match(html, /Earlier title/u);
  assert.match(html, /<details[^>]*\bopen=/u);
  assert.doesNotMatch(html, /Latest title|Latest detail/u);
});

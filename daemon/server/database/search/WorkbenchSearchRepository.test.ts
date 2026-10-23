/*
 * No exports. Tests protect search-owner ranking, archive exclusion, identifier/typo fallbacks and reported corrections,
 * kind/scope filters, kind arrangement and the 500ms query budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptObservation } from "../transcript/workbench-transcript-types";
import WorkbenchHistoryIndex from "../history/WorkbenchHistoryIndex";
import WorkbenchSearchRepository from "./WorkbenchSearchRepository";
import { createSearchTestDatabase, placeSearchThread, seedSearchThread } from "./search.test.fixtures";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { WORKBENCH_SEARCH_KIND_LIMITS, type WorkbenchSearchRequest } from "workbench-shared/workbench/search/workbench-search";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type Database from "better-sqlite3";

/** The worker backfills in the background; tests finish it first so seeded history is searchable. */
function backfilledSearch(database: Database.Database, options: { now?(): number } = {}) {
  const history = new WorkbenchHistoryIndex(database);
  while (history.backfillStep());
  return new WorkbenchSearchRepository(database, { ...options, history });
}

test("search ranks covered, recent narrative with match-centred excerpts and never shows archived threads", () => {
  const database = createSearchTestDatabase();
  try {
    const now = Date.UTC(2026, 8, 17);
    seedSearchThread(database, {
      activityAt: now - 2 * 86_400_000,
      assistantText: "The implementation kept the loading state lifecycle-owned.",
      id: "recent-loader",
      title: "Recent visual repair",
      userText: `${"unrelated opening context ".repeat(20)}loader animation loader animation loader`,
    });
    seedSearchThread(database, {
      activityAt: now - 60 * 86_400_000,
      assistantText: "A loader animation was mentioned once.",
      id: "stale-loader",
      title: "Old visual note",
      userText: "Please inspect the loader.",
    });
    seedSearchThread(database, {
      activityAt: now - 86_400_000,
      assistantText: "Archived loader loading animation loader loading animation.",
      id: "archived-loader",
      title: "Archived unrelated work",
      userText: "Archived narrative must stay hidden.",
    });
    seedSearchThread(database, {
      activityAt: now - 86_400_000,
      assistantText: "loader loading animation",
      id: "placed-archive",
      title: "Placed in archive",
      userText: "",
    });
    seedSearchThread(database, { activityAt: now - 2 * 86_400_000, assistantText: "freshnesssignal", id: "recent-freshness", title: "Recent freshness result", userText: "" });
    seedSearchThread(database, { activityAt: now - 60 * 86_400_000, assistantText: "", id: "stale-freshness", title: "Stale freshness result", userText: "freshnesssignal" });
    database.prepare("UPDATE workbench_threads SET archived = 1 WHERE id = 'archived-loader'").run();
    placeSearchThread(database, "placed-archive", { archived: true });

    const repository = backfilledSearch(database, { now: () => now });
    const results = repository.search({ projectId: testProjectIds.project, query: "loader loading animation" })
      .results.filter(result => result.kind === "thread");
    assert.deepEqual(results.map(({ title }) => title), ["Recent visual repair", "Old visual note"]);
    const excerpt = results[0]?.kind === "thread" ? results[0].excerpt : undefined;
    assert.equal(excerpt?.role, "user");
    assert.match(excerpt?.text ?? "", /^\.\.\..*loader animation/u);
    assert.deepEqual(repository.search({ projectId: testProjectIds.project, query: "\"Archived unrelated work\"" }).results, []);
    assert.deepEqual(repository.search({ projectId: testProjectIds.project, query: "freshnesssignal" }).results.map(({ title }) => title),
      ["Recent freshness result", "Stale freshness result"]);
  } finally { database.close(); }
});

test("squashed identifiers and typos still find narrative, while real words never pull in their misspelt neighbours", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "dialog", title: "Polish overlay", userText: "WorkbenchSearchDialog flickers", assistantText: "fixed the focus trap" });
    seedSearchThread(database, { id: "kitchen", title: "Cooking notes", userText: "add more starch to the sauce", assistantText: "done" });
    seedSearchThread(database, { id: "typo", title: "Notes", userText: "the serch box is slow", assistantText: "noted" });
    const repository = backfilledSearch(database);
    const threads = (query: string) => repository.search({ projectId: null, query }).results
      .flatMap(result => result.kind === "thread" ? [result.threadId] : []);

    assert.deepEqual(threads("SearchDialog"), ["dialog"]);
    assert.deepEqual(threads("focus trap"), ["dialog"]);
    assert.deepEqual(threads("starch"), ["kitchen"], "an exact word stays exact");
    assert.deepEqual(threads("stach"), ["kitchen"], "a word nothing contains falls back to its nearest spelling");
    assert.deepEqual(threads("serch"), ["typo"], "a misspelling that literally occurs is matched as typed");
    assert.deepEqual(repository.search({ projectId: null, query: "stach" }).corrections, [{ from: "stach", to: "starch" }]);
    assert.equal(repository.search({ projectId: null, query: "starch" }).corrections, undefined);
  } finally { database.close(); }
});

test("requested kinds and project-only scope narrow results, and one kind may fill the response", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "here", title: "Widget here", userText: "widget", assistantText: "ok" });
    seedSearchThread(database, { id: "elsewhere", projectId: testProjectIds.other, title: "Widget elsewhere", userText: "widget", assistantText: "ok" });
    const repository = backfilledSearch(database);
    repository.replaceProjects([{ id: testProjectIds.project, name: "Project", rootPath: "C:/project" }]);
    repository.replaceProjectFiles(testProjectIds.project, Array.from({ length: 30 }, (_, index) => `src/widget-${index}.ts`));
    const search = (request: Partial<WorkbenchSearchRequest>) => repository.search({ projectId: testProjectIds.project, query: "widget", ...request }).results;

    assert.equal(search({}).filter(result => result.kind === "file").length, WORKBENCH_SEARCH_KIND_LIMITS.file);
    const files = search({ kinds: ["file"] });
    assert.equal(files.length, 30);
    assert.ok(files.every(result => result.kind === "file"));
    assert.deepEqual(search({ kinds: ["thread"] }).map(result => result.id).sort(), ["thread:elsewhere", "thread:here"]);
    assert.deepEqual(search({ kinds: ["thread"], projectOnly: true }).map(result => result.id), ["thread:here"]);
  } finally { database.close(); }
});

test("files match their basename before their folders, initials reach them, and an empty query lists recent threads instead of files", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { activityAt: 5, id: "recent", title: "Recent thread", userText: "hello", assistantText: "hi" });
    const repository = backfilledSearch(database);
    repository.replaceProjects([{ id: testProjectIds.project, name: "Project", rootPath: "C:/project" }]);
    repository.replaceProjectFiles(testProjectIds.project, [
      "app/search/notes.ts", "app/client/WorkbenchSearchDialog.tsx", "app/client/search-dialog.css",
    ]);
    const search = (query: string) => repository.search({ projectId: testProjectIds.project, query }).results;

    const files = search("dialog").filter(result => result.kind === "file");
    assert.deepEqual(files.map(result => result.kind === "file" ? result.path : ""), ["app/client/search-dialog.css", "app/client/WorkbenchSearchDialog.tsx"]);
    assert.deepEqual(files.map(({ title, detail }) => [title, detail])[0], ["search-dialog.css", "app/client"]);
    assert.equal(search("search").find(result => result.kind === "file")?.title, "search-dialog.css",
      "a basename hit outranks a folder hit");
    assert.equal(search("wsd").find(result => result.kind === "file")?.title, "WorkbenchSearchDialog.tsx");
    const empty = search("");
    assert.equal(empty[0]?.kind, "thread");
    assert.ok(!empty.some(result => result.kind === "file" || result.kind === "projectSetting"));
  } finally { database.close(); }
});

test("search stays below 500ms per query on a multi-megabyte relational corpus", (t) => {
  const database = createSearchTestDatabase();
  try {
    const transcript = new WorkbenchTranscriptRepository(database);
    const observations: WorkbenchTranscriptObservation[] = [];
    const vocabulary = ["controller", "database", "performance", "project", "request", "response", "selection", "thread", "architecture", "validation"];
    const paragraph = Array.from({ length: 1000 }, (_, index) => `${vocabulary[index % vocabulary.length]}${index} handles requests and preserves current state.`).join(" ");
    let corpusCharacters = 0;
    for (let index = 0; index < 920; index++) {
      const threadId = `search-thread-${index}`;
      const turnId = `search-turn-${index}`;
      const title = `Project maintenance ${index}`;
      const catalog = {
        kind: "thread" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), projectId: testProjectIds.project, projectRoot: "C:/project",
        title, createdAt: 1, updatedAt: index + 1, activityAt: index + 1,
      };
      if (index >= 42) {
        observations.push({ kind: "turnCatalog", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), catalog: [catalog] });
        continue;
      }
      const text = `${index === 0 ? "quartzzeppelin exact phrase " : ""}${paragraph}`;
      corpusCharacters += text.length;
      observations.push({
        kind: "canonicalWindow", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), contentVersion: 3, materializedTurnIds: [fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId)],
        observations: [
          catalog,
          {
            kind: "turn", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), turnIndex: 0, harnessId: "codex",
            nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(threadId), nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse(turnId),
            state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1,
          },
          {
            kind: "item", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId), lifecycle: "completed", observedAt: 2,
            item: {
              id: `body-${index}`, type: "agentMessage", phase: "commentary",
              text, delivery: null, questions: null, memoryCitation: null,
            },
          },
        ],
      });
    }
    transcript.settle(observations);
    const repository = backfilledSearch(database);
    repository.replaceProjects(Array.from({ length: 102 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`, name: `Project ${index}`, rootPath: `C:/project-${index}` })));
    repository.replaceProjectFiles(testProjectIds.project, Array.from({ length: 1200 }, (_, index) => `src/components/component-${index}.tsx`));
    assert.ok(corpusCharacters >= 2_373_411);

    const measurements = [];
    for (const query of ["", "a", "quartzzeppeln", "quartzzeppelin state", '"exact phrase"', "maintenance -quartzzeppelin", "asdlfkajsdlfkjasdlfkjasdf"]) {
      const startedAt = performance.now();
      const response = repository.search({ projectId: testProjectIds.project, query });
      const elapsedMs = performance.now() - startedAt;
      measurements.push({ query, elapsedMs });
      if (query === "asdlfkajsdlfkjasdlfkjasdf") assert.deepEqual(response.results, []);
      else assert.ok(response.results.length > 0, query);
      if (query === "quartzzeppeln" || query === '"exact phrase"') {
        assert.deepEqual(response.results.map((result) => result.id), ["thread:search-thread-0"]);
      }
      if (query === "quartzzeppelin state") assert.equal(response.results[0]?.id, "thread:search-thread-0");
    }
    t.diagnostic(`corpus=${corpusCharacters} chars; ${measurements.map(({ query, elapsedMs }) => `${query || "(empty)"}=${elapsedMs.toFixed(1)}ms`).join("; ")}`);
    for (const { query, elapsedMs } of measurements) {
      assert.ok(elapsedMs < 500, `${query || "(empty)"} took ${elapsedMs.toFixed(1)}ms, exceeding the 500ms search budget`);
    }
  } finally {
    database.close();
  }
});

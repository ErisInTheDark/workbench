/*
 * No exports. Tests protect search-owner correctness and the 500ms query budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";

import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository";
import type { WorkbenchTranscriptObservation } from "../transcript/workbench-transcript-types";
import WorkbenchSearchRepository from "./WorkbenchSearchRepository";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

test("search stays below 500ms per query on a multi-megabyte relational corpus", (t) => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
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
        kind: "thread" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), projectRoot: "C:/project",
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
    const repository = new WorkbenchSearchRepository(database);
    repository.replaceProjects(Array.from({ length: 102 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, rootPath: `C:/project-${index}` })));
    repository.replaceProjectFiles("project", Array.from({ length: 1200 }, (_, index) => `src/components/component-${index}.tsx`));
    assert.ok(corpusCharacters >= 2_373_411);

    const measurements = [];
    for (const query of ["", "a", "quartzzeppeln", "quartzzeppelin state", '"exact phrase"', "maintenance -quartzzeppelin", "asdlfkajsdlfkjasdlfkjasdf"]) {
      const startedAt = performance.now();
      const response = repository.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query });
      const elapsedMs = performance.now() - startedAt;
      measurements.push({ query, elapsedMs });
      if (query === "asdlfkajsdlfkjasdlfkjasdf") assert.deepEqual(response.results, []);
      else assert.ok(response.results.length > 0, query);
      if (query === "quartzzeppeln" || query === "quartzzeppelin state" || query === '"exact phrase"') {
        assert.deepEqual(response.results.map((result) => result.id), ["thread:search-thread-0"]);
      }
    }
    t.diagnostic(`corpus=${corpusCharacters} chars; ${measurements.map(({ query, elapsedMs }) => `${query || "(empty)"}=${elapsedMs.toFixed(1)}ms`).join("; ")}`);
    for (const { query, elapsedMs } of measurements) {
      assert.ok(elapsedMs < 500, `${query || "(empty)"} took ${elapsedMs.toFixed(1)}ms, exceeding the 500ms search budget`);
    }
  } finally {
    database.close();
  }
});

/*
 * No production exports. Tests protect reviewer settings and dispatch: sealed keys stay device-bound,
 * and a review only runs with a selected, usable reviewer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { compileWorkbenchDatabaseStatement, type WorkbenchDatabaseRow } from "workbench-shared/database/workbench-database-statements";
import { renderCreateTable } from "workbench-shared/database/schema/schema-definition";
import { approvalReviewSecrets, approvalReviewSelection } from "../lib/workbench/database/schema/approval-review-schema";
import WorkbenchApprovalReviewController, { type WorkbenchApprovalReviewOptions } from "./WorkbenchApprovalReviewController";

const subject = {
  kind: "command" as const, command: "winget install foo", cwd: "C:/", commandActions: [],
  justification: "User asked to install foo.", networkTarget: null, rememberable: true, suggestedPrefixes: [],
};

function setup(overrides: Partial<WorkbenchApprovalReviewOptions> = {}) {
  const database = new Database(":memory:");
  const tables = { [approvalReviewSelection.name]: approvalReviewSelection, [approvalReviewSecrets.name]: approvalReviewSecrets };
  for (const table of Object.values(tables)) database.exec(renderCreateTable(table));
  const port: WorkbenchApprovalReviewOptions["database"] = {
    query: async <Row extends WorkbenchDatabaseRow>(query: Parameters<WorkbenchApprovalReviewOptions["database"]["query"]>[0]) => {
      const compiled = compileWorkbenchDatabaseStatement(tables, query);
      return database.prepare(compiled.sql).all(...compiled.parameters) as Row[];
    },
    executeTransaction: async statements => database.transaction(() => {
      let changes = 0;
      for (const statement of statements) {
        const compiled = compileWorkbenchDatabaseStatement(tables, statement);
        changes += database.prepare(compiled.sql).run(...compiled.parameters).changes;
      }
      return { changes };
    })(),
  };
  const create = (options: Partial<WorkbenchApprovalReviewOptions> = {}) => new WorkbenchApprovalReviewController({
    database: port, readDeviceIdentity: async () => "device-a", readOpenCodeApiKey: async () => null,
    codexReviewer: () => null, user: () => "chiri", ...overrides, ...options,
  });
  return { create, close: () => database.close() };
}

test("a saved key survives owner replacement, is never stored in plain text, and another device reads it as unset", async () => {
  const { create, close } = setup();
  try {
    await create().update({ selected: "typesafe-jev", secrets: { "typesafe-jev": "ts-key" } });
    const reread = await create().read();
    assert.equal(reread.selected, "typesafe-jev");
    const typesafe = reread.reviewers.find(reviewer => reviewer.id === "typesafe-jev");
    assert.equal(typesafe?.ready, true);
    assert.equal(typesafe?.secret, "ts-key");
    const elsewhere = await create({ readDeviceIdentity: async () => "device-b" }).read();
    assert.equal(elsewhere.reviewers.find(reviewer => reviewer.id === "typesafe-jev")?.ready, false);
    await create().update({ secrets: { "typesafe-jev": null } });
    assert.equal((await create().read()).reviewers.find(reviewer => reviewer.id === "typesafe-jev")?.secret, null);
    await assert.rejects(create().update({ secrets: { "zen-jev": "nope" } }), /Workbench-held key/u);
  } finally { close(); }
});

test("reviews go to the selected reviewer and refuse without a selection or usable credential", async () => {
  const { create, close } = setup();
  try {
    await assert.rejects(create().review(subject, new AbortController().signal), /No auto-approve reviewer/u);

    await create().update({ selected: "zen-jev" });
    await assert.rejects(create().review(subject, new AbortController().signal), /no usable credential/u);
    const sent: string[] = [];
    const zen = create({
      readOpenCodeApiKey: async () => "oc-key",
      fetch: (async (url: string, init: RequestInit) => {
        sent.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
        return new Response(JSON.stringify({ answers: { safe_unattended: { type: "noul", noul: 0.2 } } }));
      }) as unknown as typeof fetch,
    });
    assert.equal((await zen.review(subject, new AbortController().signal)).decision, "manual");
    assert.deepEqual(sent, ["https://opencode.ai/zen/v1/systemone Bearer oc-key"]);

    await create().update({ selected: "codex-auto-review" });
    await assert.rejects(create().review(subject, new AbortController().signal), /Codex is not installed/u);
    const states: string[] = [];
    const codex = create({ codexReviewer: () => ({ review: async state => { states.push(state); return { decision: "allow", detail: "ok" }; } }) });
    assert.equal((await codex.review(subject, new AbortController().signal)).decision, "allow");
    assert.match(states[0]!, /winget install foo/u);
  } finally { close(); }
});

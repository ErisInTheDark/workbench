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
  const warnings: string[] = [];
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
    codexReviewer: () => null, user: () => "chiri", warn: message => { warnings.push(message); },
    fetch: (async () => { throw new Error("offline in tests"); }) as unknown as typeof fetch,
    ...overrides, ...options,
  });
  return { create, warnings, close: () => database.close() };
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
    const codex = create({ codexReviewer: () => ({
      availability: async () => ({ ready: true, detail: null }),
      review: async state => { states.push(state); return { decision: "allow", detail: "ok" }; },
    }) });
    assert.equal((await codex.review(subject, new AbortController().signal)).decision, "allow");
    assert.match(states[0]!, /winget install foo/u);
  } finally { close(); }
});

function zenFetch(models: readonly string[], sent: string[]) {
  return (async (url: string, init: RequestInit) => {
    sent.push(`${url} ${(init.headers as Record<string, string>).Authorization}${init.body ? ` ${JSON.parse(String(init.body)).model}` : ""}`);
    return url.endsWith("/models")
      ? new Response(JSON.stringify({ data: models.map(id => ({ id })) }))
      : new Response(JSON.stringify({ answers: { safe_unattended: { type: "noul", noul: 0.95 } } }));
  }) as unknown as typeof fetch;
}

test("free Zen Jev works signed out with the catalogue's free model, and is unavailable when Zen lists none", async () => {
  const { create, close } = setup();
  try {
    await create().update({ selected: "zen-jev-free" });
    const sent: string[] = [];
    const signedOut = create({ fetch: zenFetch(["jev-latest", "jev-latest-free"], sent) });
    assert.deepEqual((await signedOut.read()).reviewers.find(reviewer => reviewer.id === "zen-jev-free"), { id: "zen-jev-free", ready: true, detail: null });
    assert.equal((await signedOut.review(subject, new AbortController().signal)).decision, "allow");
    assert.ok(sent.includes("https://opencode.ai/zen/v1/systemone Bearer public jev-latest-free"));

    const withdrawn = create({ fetch: zenFetch(["jev-latest"], []) });
    assert.equal((await withdrawn.read()).reviewers.find(reviewer => reviewer.id === "zen-jev-free")?.ready, false);
    await assert.rejects(withdrawn.review(subject, new AbortController().signal), /not offered/u);
  } finally { close(); }
});

test("provider and credential failures read as unavailable reviewers and are reported, instead of failing the settings read", async () => {
  const { create, warnings, close } = setup();
  try {
    const snapshot = await create({
      readOpenCodeApiKey: async () => { throw new Error("bad auth.json"); },
      codexReviewer: () => ({
        availability: async () => { throw new Error("app server down"); },
        review: async () => ({ decision: "manual", detail: "unused" }),
      }),
    }).read();
    for (const reviewer of snapshot.reviewers.filter(item => item.id !== "typesafe-jev")) {
      assert.equal(reviewer.ready, false, reviewer.id);
      assert.ok(reviewer.detail, reviewer.id);
    }
    assert.ok(warnings.some(message => /app server down/u.test(message)));
    assert.ok(warnings.some(message => /bad auth\.json/u.test(message)));
  } finally { close(); }
});

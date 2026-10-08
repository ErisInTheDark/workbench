/* No exports. Protect ownership proof, flattening and rejection of conflicting aliases. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectIdSchema } from "../identity";
import { testProjectIds } from "../test-identities";
import { composeProjectAliases } from "./project-aliases";

test("conversion flattens retained addresses and repeated adoption has no changes", () => {
  const old = ProjectIdSchema.parse("remote://example.test/old/repo");
  const existing = [{ alias: "checkout", projectId: old }];
  const converted = composeProjectAliases(existing, [
    { alias: "checkout", projectId: testProjectIds.project },
    { alias: old, projectId: testProjectIds.project },
  ]);
  assert.equal(converted.aliases.length, 2);
  assert.ok(converted.aliases.every(item => item.projectId === testProjectIds.project));
  assert.deepEqual(composeProjectAliases(converted.aliases, converted.aliases).changes, []);
  assert.deepEqual(existing, [{ alias: "checkout", projectId: old }]);
});

test("unproven reassignment, conflicting inputs and cycles cannot change ownership", () => {
  const existing = [{ alias: "checkout", projectId: testProjectIds.project }];
  assert.throws(() => composeProjectAliases(existing, [
    { alias: "checkout", projectId: testProjectIds.other },
  ]), /ownership/);
  assert.throws(() => composeProjectAliases([], [
    { alias: "checkout", projectId: testProjectIds.project },
    { alias: "checkout", projectId: testProjectIds.other },
  ]), /conflicting/);
  assert.throws(() => composeProjectAliases([], [
    { alias: testProjectIds.project, projectId: testProjectIds.other },
    { alias: testProjectIds.other, projectId: testProjectIds.project },
  ]), /cycles/);
  assert.deepEqual(existing, [{ alias: "checkout", projectId: testProjectIds.project }]);
});

test("a previous daemon project ID can resolve to the fixed daemon-local project ID", () => {
  const alias = "0aa9955c-be42-4f99-a93b-54f45f94eebd";
  const result = composeProjectAliases([], [{
    alias,
    projectId: ProjectIdSchema.parse("daemon"),
  }]);

  assert.deepEqual(result, {
    aliases: [{ alias, projectId: "daemon" }],
    changes: [{ alias, projectId: "daemon" }],
    removals: [],
  });
});

test("a fixed daemon ID replaces its obsolete reverse alias", () => {
  const old = ProjectIdSchema.parse("0aa9955c-be42-4f99-a93b-54f45f94eebd");
  const result = composeProjectAliases(
    [{ alias: "daemon", projectId: old }],
    [{ alias: old, projectId: ProjectIdSchema.parse("daemon") }],
  );

  assert.deepEqual(result, {
    aliases: [{
      alias: "0aa9955c-be42-4f99-a93b-54f45f94eebd",
      projectId: "daemon",
    }],
    changes: [{
      alias: "0aa9955c-be42-4f99-a93b-54f45f94eebd",
      projectId: "daemon",
    }],
    removals: ["daemon"],
  });
});

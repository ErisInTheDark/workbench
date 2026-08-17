/* No production exports. Tests protect bounded nested client schema diagnostics without rejected payload values. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";

import reportClientSchemaError from "./report-client-schema-error";

test("client schema errors expose useful nested issues without payload values", (context) => {
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values) => messages.push(values.map(String).join(" "));
  context.after(() => { console.error = originalConsoleError; });

  const schema = z.union([
    z.object({ kind: z.literal("alpha"), value: z.string() }).strict(),
    z.object({ kind: z.literal("beta"), nested: z.object({ allowed: z.string() }).strict() }).strict(),
  ]);
  const parsed = schema.safeParse({ kind: "beta", nested: { allowed: "yes", secretField: "never-log-me" } });
  assert.equal(parsed.success, false);
  if (parsed.success) return;

  reportClientSchemaError("Rejected remote update", parsed.error);

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /nested: Unrecognized key: "secretField"/u);
  assert.doesNotMatch(messages[0] ?? "", /never-log-me/u);
  assert.ok((messages[0]?.length ?? 0) <= "Rejected remote update: ".length + 1_000);
});

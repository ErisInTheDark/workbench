/*
 * No production exports. Tests protect catalogue model lookup: one listing serves lookups until it ages out,
 * and a failed listing is retried rather than remembered.
 */
import assert from "node:assert/strict";
import test from "node:test";
import ReviewerModelCatalogue, { REVIEWER_CATALOGUE_MAX_AGE_MS } from "./ReviewerModelCatalogue";

const model = { catalogue: "https://zen.test/v1/models", pattern: /^jev(?:-.*)?-free$/u };

test("one listing answers lookups until it ages out, and failed listings are retried", async () => {
  let now = 0;
  let listings = 0;
  let fail = true;
  const catalogue = new ReviewerModelCatalogue({
    now: () => now,
    fetch: (async () => {
      listings += 1;
      if (fail) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ data: [{ id: "jev-latest" }, { id: "jev-latest-free" }] }));
    }) as unknown as typeof fetch,
  });

  await assert.rejects(catalogue.resolve(model, "public"), /HTTP 503/u);
  fail = false;
  assert.equal(await catalogue.resolve(model, "public"), "jev-latest-free");
  assert.equal(await catalogue.resolve(model, "public"), "jev-latest-free");
  assert.equal(listings, 2);

  now += REVIEWER_CATALOGUE_MAX_AGE_MS;
  assert.equal(await catalogue.resolve(model, "public"), "jev-latest-free");
  assert.equal(listings, 3);
  assert.equal(await catalogue.resolve("jev-1.13", "key"), "jev-1.13");
  assert.equal(listings, 3);
});

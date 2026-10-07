/*
 * No production exports. Tests protect the Jev boundary: only a confident "safe" answer auto-approves, and bad replies never decide.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewWithSystemOne, SYSTEMONE_ALLOW_THRESHOLD } from "./systemone-approval-reviewer";

const input = { label: "Jev", url: "https://example.test/v1/systemone", model: "jev-latest", apiKey: "secret", state: "rm -rf build" };

function reply(body: unknown, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function noul(value: number) {
  return { model: "jev-1.13.0", answers: { safe_unattended: { type: "noul", noul: value } } };
}

test("a safe answer at the threshold allows, just below it asks the person", async () => {
  const allowed = reply(noul(SYSTEMONE_ALLOW_THRESHOLD));
  assert.equal((await reviewWithSystemOne(input, new AbortController().signal, allowed.fetchImpl)).decision, "allow");
  const doubtful = reply(noul(SYSTEMONE_ALLOW_THRESHOLD - 0.01));
  assert.equal((await reviewWithSystemOne(input, new AbortController().signal, doubtful.fetchImpl)).decision, "manual");

  const sent = JSON.parse(String(allowed.requests[0]!.init.body)) as { model: string; state: string; questions: Record<string, { type: string }> };
  assert.equal((allowed.requests[0]!.init.headers as Record<string, string>).Authorization, "Bearer secret");
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.state, "rm -rf build");
  assert.deepEqual(Object.values(sent.questions).map(question => question.type), ["noul"]);
});

test("HTTP failures and unexpected answers throw instead of deciding", async () => {
  await assert.rejects(reviewWithSystemOne(input, new AbortController().signal, reply({}, 401).fetchImpl), /HTTP 401/u);
  await assert.rejects(reviewWithSystemOne(input, new AbortController().signal, reply({ answers: {} }).fetchImpl), /unexpected/u);
  await assert.rejects(reviewWithSystemOne(input, new AbortController().signal, reply(noul(1.5)).fetchImpl), /unexpected/u);
});

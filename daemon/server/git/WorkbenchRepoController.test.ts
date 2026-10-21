/* Exports: none. Tests cover virtual repository leases, expiry, restart reconciliation, availability, hydration and handoff. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { VirtualRepoAvailability } from "workbench-shared/workbench/repo/virtual-repo-contract";
import WorkbenchRepoController, { REPO_LEASE_MS, type WorkbenchRepoSidecar } from "./WorkbenchRepoController";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

class FakeSidecar implements WorkbenchRepoSidecar {
  failed = false;
  closed = false;
  readonly requests: Array<{ action: string; payload: Record<string, unknown> }> = [];
  constructor(private readonly commits: string[]) {}
  async request(action: string, payload: object) {
    this.requests.push({ action, payload: payload as Record<string, unknown> });
    if (action === "warm") {
      const commit = this.commits.shift() ?? COMMIT_A;
      return { key: "github.com/team/project", commit, path: `/cache/mounts/github.com/team/project/${commit}` };
    }
    return {};
  }
  async close() { this.closed = true; }
  actions() { return this.requests.map(({ action }) => action); }
}

async function fixture(options: { commits?: string[]; availability?: VirtualRepoAvailability["status"]; cacheDirectory?: string } = {}) {
  const cacheDirectory = options.cacheDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), "wb-repo-"));
  let now = 1_000_000;
  let timer: { callback: () => Promise<void>; delayMs: number } | null = null;
  let availability: VirtualRepoAvailability = options.availability === "missing"
    ? { platform: "windows", status: "missing", requirement: "winfsp" }
    : { platform: "windows", status: "available" };
  const sidecars: FakeSidecar[] = [];
  let bumps = 0;
  const warnings: string[] = [];
  const controller = new WorkbenchRepoController({
    cacheDirectory,
    probe: async () => availability,
    startSidecar: async () => {
      const sidecar = new FakeSidecar(options.commits ?? [COMMIT_A]);
      sidecars.push(sidecar);
      return sidecar;
    },
    bumpToolRevision: () => { bumps++; },
    warn: message => { warnings.push(message); },
    now: () => now,
    setTimer: (callback, delayMs) => {
      timer = { callback, delayMs };
      return { cancel: () => { if (timer?.callback === callback) timer = null; } };
    },
  });
  return {
    controller, cacheDirectory, sidecars, warnings,
    get bumps() { return bumps; },
    get timer() { return timer; },
    advance(ms: number) { now += ms; },
    setAvailability(next: VirtualRepoAvailability) { availability = next; },
    async readLeases() {
      return JSON.parse(await fs.readFile(path.join(cacheDirectory, "leases.json"), "utf8")) as { leases: Array<{ commit: string; expiresAt: number }> };
    },
  };
}

async function warm(controller: WorkbenchRepoController, body: object = { url: "https://github.com/team/project.git" }) {
  const response = await controller.warm(body, new AbortController().signal);
  return { status: response.status, text: (await response.text()).trim() };
}

test("warm returns only the pinned path and persists a 24-hour lease", async () => {
  const repo = await fixture();
  await repo.controller.refreshAvailability();
  const result = await warm(repo.controller, { url: "https://github.com/team/project.git", ref: "main" });
  assert.deepEqual(result, { status: 200, text: `/cache/mounts/github.com/team/project/${COMMIT_A}` });
  assert.deepEqual(repo.sidecars[0]!.requests.find(({ action }) => action === "warm")?.payload,
    { url: "https://github.com/team/project.git", ref: "main", kind: "" });
  const { leases } = await repo.readLeases();
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.expiresAt, 1_000_000 + REPO_LEASE_MS);
  assert.equal(repo.timer?.delayMs, REPO_LEASE_MS);
});

test("only explicit warms renew a lease, and each commit expires on its own", async () => {
  const repo = await fixture({ commits: [COMMIT_A, COMMIT_B, COMMIT_A] });
  await repo.controller.refreshAvailability();
  await warm(repo.controller);
  repo.advance(REPO_LEASE_MS / 2);
  await warm(repo.controller); // the ref moved: a new commit with its own lease
  const sidecar = repo.sidecars[0]!;
  repo.advance(REPO_LEASE_MS / 2);
  await repo.timer!.callback();
  assert.equal((await repo.readLeases()).leases.length, 1);
  assert.deepEqual(sidecar.requests.filter(({ action }) => action === "unmount").map(({ payload }) => payload.commit), [COMMIT_A]);
  assert.equal(sidecar.actions().includes("evict"), false, "the repository stays cached while another commit is leased");

  repo.advance(REPO_LEASE_MS / 2);
  await repo.timer!.callback();
  assert.equal((await repo.readLeases()).leases.length, 0);
  assert.deepEqual(sidecar.actions().slice(-2), ["unmount", "evict"], "the last lease evicts the repository");
  assert.equal(repo.timer, null);
});

test("hydrate prefetches the leased subtree a path names and ignores paths outside mounts", async () => {
  const repo = await fixture();
  await repo.controller.refreshAvailability();
  const { text: mount } = await warm(repo.controller);
  const signal = new AbortController().signal;
  await repo.controller.hydrate(path.join(mount, "packages", "core"), signal);
  await repo.controller.hydrate(mount, signal);
  await repo.controller.hydrate(`${mount}-sibling`, signal);
  await repo.controller.hydrate(path.resolve("/elsewhere/project"), signal);
  const prefetches = repo.sidecars[0]!.requests.filter(({ action }) => action === "prefetch").map(({ payload }) => payload);
  assert.deepEqual(prefetches, [
    { key: "github.com/team/project", commit: COMMIT_A, path: "packages/core" },
    { key: "github.com/team/project", commit: COMMIT_A, path: "" },
  ]);
});

test("hydrate never starts a sidecar for paths outside leased mounts", async () => {
  const repo = await fixture();
  await repo.controller.refreshAvailability();
  await repo.controller.hydrate(path.resolve("/elsewhere/project"), new AbortController().signal);
  assert.equal(repo.sidecars.length, 0);
});

test("restart drops expired leases, sweeps their cache and remounts live ones", async () => {
  const first = await fixture({ commits: [COMMIT_A, COMMIT_B] });
  await first.controller.refreshAvailability();
  await warm(first.controller);
  first.advance(REPO_LEASE_MS - 10);
  await warm(first.controller);
  await first.controller.suspend();
  assert.equal(first.sidecars[0]!.closed, true, "suspending closes the sidecar so mounts end before a replacement starts");

  const restarted = await fixture({ cacheDirectory: first.cacheDirectory });
  restarted.advance(REPO_LEASE_MS); // COMMIT_A expired while the daemon slept
  await restarted.controller.start();
  const sidecar = restarted.sidecars[0]!;
  assert.deepEqual(sidecar.requests[0], { action: "sweep", payload: { keep: ["github.com/team/project"] } });
  assert.deepEqual(sidecar.requests.filter(({ action }) => action === "remount").map(({ payload }) => payload.commit), [COMMIT_B]);
  assert.equal((await restarted.readLeases()).leases.length, 1);
  assert.deepEqual(restarted.warnings, []);
});

test("unavailable runtimes reject warms without starting a sidecar", async () => {
  const repo = await fixture({ availability: "missing" });
  await repo.controller.refreshAvailability();
  const result = await warm(repo.controller);
  assert.equal(result.status, 503);
  assert.match(result.text, /WinFsp is not installed/);
  assert.equal(repo.sidecars.length, 0);
});

test("availability changes bump the tool revision once per flip", async () => {
  const repo = await fixture({ availability: "missing" });
  await repo.controller.refreshAvailability();
  assert.equal(repo.bumps, 0);
  repo.setAvailability({ platform: "windows", status: "available" });
  await repo.controller.refreshAvailability();
  await repo.controller.refreshAvailability();
  assert.equal(repo.bumps, 1);
  assert.equal(repo.controller.isAvailable(), true);
  repo.setAvailability({ platform: "windows", status: "checkFailed" });
  await repo.controller.refreshAvailability();
  assert.equal(repo.bumps, 2);
  assert.equal(repo.controller.isAvailable(), false, "a failed check never exposes the command");
});

test("credentialed URLs are rejected before reaching the sidecar", async () => {
  const repo = await fixture();
  await repo.controller.refreshAvailability();
  const result = await warm(repo.controller, { url: "https://user:token@github.com/team/project.git" });
  assert.equal(result.status, 400);
  assert.doesNotMatch(result.text, /token/);
  assert.equal(repo.sidecars.length, 0);
});

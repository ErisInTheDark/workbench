/* No production exports. Tests protect Claude config-view sanitization, credential routing, and link-safe disposal. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ClaudeConfigView from "./ClaudeConfigView";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "wb-claude-view-"));
  const home = path.join(base, "home");
  const real = path.join(home, ".claude");
  await mkdir(path.join(real, "projects", "existing"), { recursive: true });
  await writeFile(path.join(real, "projects", "existing", "session.jsonl"), "{}\n");
  await writeFile(path.join(real, ".credentials.json"), "secret");
  await writeFile(path.join(real, "settings.json"), "{\"theme\":\"auto\"}");
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({
    numStartups: 3,
    oauthAccount: {
      accountUuid: "account", emailAddress: "person@example.com", organizationUuid: "org",
      billingType: "subscription", accountCreatedAt: "a", subscriptionCreatedAt: "b",
      ccOnboardingFlags: {}, profileFetchedAt: 1,
    },
  }));
  return { base, home, real, views: path.join(base, "views") };
}

test("a view hides the account email, keeps profile freshness facts, and leaves credentials in the real store", async () => {
  const { base, home, real, views } = await fixture();
  const view = await ClaudeConfigView.create(views, { env: {}, home }, 5_000);
  try {
    const root = view.env.CLAUDE_CONFIG_DIR!;
    const config = JSON.parse(await readFile(path.join(root, ".claude.json"), "utf8"));
    assert.equal(config.oauthAccount.emailAddress, undefined);
    assert.equal(config.oauthAccount.profileFetchedAt, 5_000);
    assert.equal(config.oauthAccount.billingType, "subscription");
    assert.equal(config.numStartups, 3);
    assert.equal(await readFile(path.join(root, "settings.json"), "utf8"), "{\"theme\":\"auto\"}");
    assert.ok(!(await readdir(root)).includes(".credentials.json"));
    assert.equal(view.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, "");
    assert.ok((await readFile(path.join(home, ".claude.json"), "utf8")).includes("person@example.com"));
    await writeFile(path.join(root, "projects", "existing", "new.jsonl"), "{}\n");
    assert.ok((await readdir(path.join(real, "projects", "existing"))).includes("new.jsonl"));
  } finally {
    await view.dispose();
  }
  assert.deepEqual(await readdir(views), []);
  assert.deepEqual((await readdir(path.join(real, "projects", "existing"))).sort(), ["new.jsonl", "session.jsonl"]);
  assert.equal(await readFile(path.join(real, ".credentials.json"), "utf8"), "secret");
  await rm(base, { recursive: true });
});

test("credential routing matches the store Claude would have used without a view", async () => {
  const { base, home, views } = await fixture();
  const configured = path.join(base, "configured");
  await mkdir(configured);
  for (const [env, expected] of [
    [{ CLAUDE_CONFIG_DIR: configured }, configured],
    [{ CLAUDE_CONFIG_DIR: configured, CLAUDE_SECURESTORAGE_CONFIG_DIR: "elsewhere" }, "elsewhere"],
  ] as const) {
    const view = await ClaudeConfigView.create(views, { env, home });
    try {
      assert.equal(view.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, expected);
      assert.notEqual(view.env.CLAUDE_CONFIG_DIR, configured);
    } finally {
      await view.dispose();
    }
  }
  assert.ok((await readdir(configured)).includes("projects"), "native sessions must have a real home before linking");
  await rm(base, { recursive: true });
});

test("sweeping retires views from dead processes without touching linked data or live views", async () => {
  const { base, home, real, views } = await fixture();
  const live = await ClaudeConfigView.create(views, { env: {}, home });
  const stale = path.join(views, "999999999-stale");
  await mkdir(path.join(stale, "scratch"), { recursive: true });
  await writeFile(path.join(stale, "scratch", "file.txt"), "x");
  await symlink(path.join(real, "projects"), path.join(stale, "projects"), "junction");
  await ClaudeConfigView.sweep(views);
  assert.deepEqual(await readdir(views), [path.basename(live.env.CLAUDE_CONFIG_DIR!)]);
  await live.dispose();
  assert.ok((await readdir(path.join(real, "projects", "existing"))).includes("session.jsonl"));
  await rm(base, { recursive: true });
});

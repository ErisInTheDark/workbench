/* No production exports. Tests protect repository identity equivalence and local/workspace separation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { localProjectKey, remoteProjectKey, workspaceProjectKey } from "./project-identity";

test("SSH and HTTPS origins identify the same repository without retaining credentials", () => {
  const id = remoteProjectKey("https://user:private-token@GITHUB.com/owner/repository.git");
  assert.equal(id, remoteProjectKey("git@github.com:owner/repository.git"));
  assert.equal(id, remoteProjectKey("ssh://git@github.com:22/owner/repository"));
  assert.equal(id, remoteProjectKey("https://github.com:443/owner/repository/"));
  assert.ok(!id.includes("private-token"));
  assert.notEqual(id, remoteProjectKey("https://github.com/fork/repository.git"));
  assert.notEqual(id, remoteProjectKey("https://elsewhere.test/owner/repository.git"));
  assert.notEqual(id, remoteProjectKey("https://github.com/owner/Repository.git"));
});

test("non-default transport ports do not collapse into default repository identity", () => {
  const id = remoteProjectKey("ssh://git@example.test:2222/owner/repository");
  assert.notEqual(id, remoteProjectKey("ssh://git@example.test/owner/repository"));
  assert.notEqual(id, remoteProjectKey("https://example.test:2222/owner/repository"));
});

test("invalid or unsupported origins cannot become a guessed repository identity", () => {
  for (const origin of ["", "not an origin", "ext::command", "https://host/", "https://host/repo?token=secret"]) {
    assert.throws(() => remoteProjectKey(origin), /origin/i);
  }
});

test("local identities follow canonical platform path equality without treating relative paths as absolute", () => {
  assert.equal(localProjectKey("C:\\Git\\Example", "win32"), localProjectKey("c:/git/example", "win32"));
  assert.notEqual(localProjectKey("/git/Example", "linux"), localProjectKey("/git/example", "linux"));
  assert.throws(() => localProjectKey("relative/path", "linux"), /absolute/i);
});

test("workspace identities depend on distinct members, not their order or checkout paths for remote members", () => {
  const first = remoteProjectKey("git@github.com:owner/first.git");
  const second = remoteProjectKey("https://github.com/owner/second");
  assert.equal(workspaceProjectKey([first, second]), workspaceProjectKey([second, first, first]));
  assert.notEqual(workspaceProjectKey([first]), workspaceProjectKey([first, second]));
  assert.notEqual(workspaceProjectKey([first, localProjectKey("/one", "linux")]), workspaceProjectKey([first, localProjectKey("/two", "linux")]));
  assert.throws(() => workspaceProjectKey([]), /member/i);
});

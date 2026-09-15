/* No production exports. Tests protect repository identity equivalence and local/workspace separation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { localProjectId, remoteProjectId, workspaceProjectId } from "./project-identity";

test("SSH and HTTPS origins identify the same repository without retaining credentials", () => {
  const id = remoteProjectId("https://user:private-token@GITHUB.com/owner/repository.git");
  assert.equal(id, remoteProjectId("git@github.com:owner/repository.git"));
  assert.equal(id, remoteProjectId("ssh://git@github.com:22/owner/repository"));
  assert.equal(id, remoteProjectId("https://github.com:443/owner/repository/"));
  assert.ok(!id.includes("private-token"));
  assert.notEqual(id, remoteProjectId("https://github.com/fork/repository.git"));
  assert.notEqual(id, remoteProjectId("https://elsewhere.test/owner/repository.git"));
  assert.notEqual(id, remoteProjectId("https://github.com/owner/Repository.git"));
});

test("non-default transport ports do not collapse into default repository identity", () => {
  const id = remoteProjectId("ssh://git@example.test:2222/owner/repository");
  assert.notEqual(id, remoteProjectId("ssh://git@example.test/owner/repository"));
  assert.notEqual(id, remoteProjectId("https://example.test:2222/owner/repository"));
});

test("invalid or unsupported origins cannot become a guessed repository identity", () => {
  for (const origin of ["", "not an origin", "ext::command", "https://host/", "https://host/repo?token=secret"]) {
    assert.throws(() => remoteProjectId(origin), /origin/i);
  }
});

test("local identities follow canonical platform path equality without treating relative paths as absolute", () => {
  assert.equal(localProjectId("C:\\Git\\Example", "win32"), localProjectId("c:/git/example", "win32"));
  assert.notEqual(localProjectId("/git/Example", "linux"), localProjectId("/git/example", "linux"));
  assert.throws(() => localProjectId("relative/path", "linux"), /absolute/i);
});

test("workspace identities depend on distinct members, not their order or checkout paths for remote members", () => {
  const first = remoteProjectId("git@github.com:owner/first.git");
  const second = remoteProjectId("https://github.com/owner/second");
  assert.equal(workspaceProjectId([first, second]), workspaceProjectId([second, first, first]));
  assert.notEqual(workspaceProjectId([first]), workspaceProjectId([first, second]));
  assert.notEqual(workspaceProjectId([first, localProjectId("/one", "linux")]), workspaceProjectId([first, localProjectId("/two", "linux")]));
  assert.throws(() => workspaceProjectId([]), /member/i);
});

/* No production exports. Protect Linux certificate trust mechanism detection and safe fallback. */
import assert from "node:assert/strict";
import test from "node:test";
import detectHostCertificatePlatform from "./host-certificate-platform";

test("non-Linux certificate trust keeps the host platform without probing Linux", () => {
  const platform = detectHostCertificatePlatform({
    platform: "win32",
    readOsRelease: () => { throw new Error("should not read Linux release metadata"); },
  });
  assert.equal(platform, "win32");
});

test("Linux certificate trust prefers NixOS then available system trust mechanisms", () => {
  const cases = [
    {
      expected: "linux:nixos",
      release: "ID=nixos\n",
      present: ["update-ca-certificates", "trust"],
    },
    {
      expected: "linux:update-ca-certificates",
      release: "ID=ubuntu\nID_LIKE=debian\n",
      present: ["update-ca-certificates", "trust"],
    },
    {
      expected: "linux:p11-kit",
      release: "ID=fedora\n",
      present: ["trust"],
    },
    {
      expected: "linux",
      release: "ID=unknown\n",
      present: [],
    },
  ] as const;
  for (const fixture of cases) {
    const platform = detectHostCertificatePlatform({
      platform: "linux",
      readOsRelease: () => fixture.release,
      pathExists: candidate => fixture.present.some(name => candidate.endsWith(`/${name}`)),
    });
    assert.equal(platform, fixture.expected);
  }
});

test("Linux certificate trust treats missing metadata as ordinary and reports unexpected reads", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const missingWarnings: string[] = [];
  assert.equal(detectHostCertificatePlatform({
    platform: "linux",
    readOsRelease: () => { throw missing; },
    pathExists: () => false,
    warn: message => missingWarnings.push(message),
  }), "linux");
  assert.deepEqual(missingWarnings, []);

  const warnings: string[] = [];
  assert.equal(detectHostCertificatePlatform({
    platform: "linux",
    readOsRelease: () => { throw Object.assign(new Error("unreadable"), { code: "EIO" }); },
    pathExists: () => true,
    warn: message => warnings.push(message),
  }), "linux");
  assert.equal(warnings.length, 1);
});
